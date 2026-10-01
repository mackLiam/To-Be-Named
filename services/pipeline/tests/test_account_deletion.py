from dataclasses import dataclass, field

import httpx
import pytest

from forms_pipeline.config import Settings
from forms_pipeline.jobs.account_deletion import (
    AccountDeletionContext,
    AccountMesh,
    AuthAdminRejectedError,
    AuthAdminTransientError,
    PendingAccount,
    PostgresAccountDeletionStore,
    SupabaseAuthAdmin,
    run_account_deletion,
)
from forms_pipeline.jobs.runner import ScanPathError
from forms_pipeline.jobs.scan_deletion import MESH_BUCKET

USER = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
GUEST = "33333333-3333-4333-8333-333333333333"


@dataclass
class FakeStorage:
    """Delete of a missing object succeeds, like a real 404. Shares `log`
    with the store and auth fakes so tests can assert cross-system order."""

    log: list[tuple]
    files: set[str] = field(default_factory=set)
    raise_on: set[str] = field(default_factory=set)

    def download(self, bucket: str, path: str) -> bytes:
        raise AssertionError("account deletion never downloads")

    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None:
        raise AssertionError("account deletion never uploads")

    def delete(self, bucket: str, path: str) -> None:
        assert bucket == MESH_BUCKET
        if path in self.raise_on:
            raise RuntimeError("simulated storage error")
        self.files.discard(path)
        self.log.append(("storage.delete", path))

    def list(self, bucket: str, prefix: str) -> list[str]:
        return sorted(p for p in self.files if p.startswith(prefix))


@dataclass
class FakeStore:
    log: list[tuple]
    accounts: list[PendingAccount] = field(default_factory=list)
    stray: dict[str, int] = field(default_factory=dict)
    meshes: dict[str, list[AccountMesh]] = field(default_factory=dict)
    guests: int = 0

    def queue_abandoned_guests(self, idle_days: int) -> int:
        self.log.append(("queue_abandoned_guests", idle_days))
        return self.guests

    def get_accounts_pending_deletion(self, limit: int) -> list[PendingAccount]:
        return self.accounts[:limit]

    def stamp_stray_scans_deleted(self, user_id: str) -> int:
        self.log.append(("stamp", user_id))
        return self.stray.get(user_id, 0)

    def get_account_meshes_to_erase(self, user_id: str) -> list[AccountMesh]:
        return self.meshes.get(user_id, [])

    def mark_mesh_erased(self, scan_id: str) -> None:
        self.log.append(("mark", scan_id))


@dataclass
class FakeAuth:
    log: list[tuple]
    fail_for: set[str] = field(default_factory=set)

    def delete_user(self, user_id: str) -> None:
        if user_id in self.fail_for:
            raise AuthAdminTransientError("auth admin returned 503")
        self.log.append(("auth.delete", user_id))


def _ctx(accounts, meshes=None, files=(), stray=None, guests=0):
    log: list[tuple] = []
    store = FakeStore(log, accounts=accounts, meshes=meshes or {}, stray=stray or {}, guests=guests)
    ctx = AccountDeletionContext(
        store=store, storage=FakeStorage(log, files=set(files)), auth=FakeAuth(log)
    )
    return ctx, log


def test_dry_run_writes_nothing_and_skips_the_guest_sweep():
    ctx, log = _ctx(
        [PendingAccount(USER, "user_request")],
        meshes={USER: [AccountMesh("s1", USER, f"{USER}/s1.obj")]},
        files=[f"{USER}/s1.obj"],
    )
    result = run_account_deletion(ctx, batch_size=10)
    assert result.considered == 1 and result.deleted == 0 and not result.armed
    assert result.guests_queued is None
    assert log == []
    assert ctx.storage.files == {f"{USER}/s1.obj"}


def test_armed_erases_meshes_before_deleting_the_user():
    files = [f"{USER}/s1.obj", f"{USER}/s1/000.jpg", f"{GUEST}/s2.obj", f"{USER}/keep.obj"]
    ctx, log = _ctx(
        [PendingAccount(USER, "user_request")],
        # s2 was merged in from a guest: its objects live under the guest prefix.
        meshes={
            USER: [
                AccountMesh("s1", USER, f"{USER}/s1.obj"),
                AccountMesh("s2", GUEST, f"{GUEST}/s2.obj"),
            ]
        },
        files=files,
        guests=3,
    )
    result = run_account_deletion(ctx, batch_size=10, armed=True, guest_idle_days=120)
    assert (result.deleted, result.skipped, result.failed, result.guests_queued) == (1, 0, 0, 3)
    assert log == [
        ("queue_abandoned_guests", 120),
        ("stamp", USER),
        ("storage.delete", f"{USER}/s1/000.jpg"),
        ("storage.delete", f"{USER}/s1.obj"),
        ("mark", "s1"),
        ("storage.delete", f"{GUEST}/s2.obj"),
        ("mark", "s2"),
        ("auth.delete", USER),
    ]
    assert ctx.storage.files == {f"{USER}/keep.obj"}


def test_stray_scans_skip_the_user_this_run():
    ctx, log = _ctx(
        [PendingAccount(USER, "user_request")],
        meshes={USER: [AccountMesh("s1", USER, f"{USER}/s1.obj")]},
        files=[f"{USER}/s1.obj"],
        stray={USER: 2},
    )
    result = run_account_deletion(ctx, batch_size=10, armed=True)
    assert result.skipped == 1 and result.deleted == 0 and result.failed == 0
    assert log == [("queue_abandoned_guests", 90), ("stamp", USER)]


def test_foreign_mesh_path_fails_the_user_and_keeps_the_account():
    ctx, log = _ctx(
        [PendingAccount(USER, "user_request")],
        meshes={USER: [AccountMesh("s1", USER, f"{OTHER}/theirs.obj")]},
        files=[f"{OTHER}/theirs.obj"],
    )
    result = run_account_deletion(ctx, batch_size=10, armed=True)
    assert result.failed == 1 and result.deleted == 0
    assert f"{OTHER}/theirs.obj" in ctx.storage.files
    assert not any(entry[0] == "auth.delete" for entry in log)


def test_one_user_failing_does_not_stop_the_next():
    ctx, log = _ctx(
        [PendingAccount(USER, "user_request"), PendingAccount(OTHER, "abandoned_guest")],
        meshes={USER: [AccountMesh("s1", USER, f"{USER}/s1.obj")]},
        files=[f"{USER}/s1.obj"],
    )
    ctx.storage.raise_on.add(f"{USER}/s1.obj")
    result = run_account_deletion(ctx, batch_size=10, armed=True)
    assert result.failed == 1 and result.deleted == 1
    assert ("auth.delete", OTHER) in log and ("auth.delete", USER) not in log
    assert ("mark", "s1") not in log


def test_auth_failure_counts_as_failed_and_next_user_continues():
    ctx, log = _ctx([PendingAccount(USER, "user_request"), PendingAccount(OTHER, "merged_guest")])
    ctx.auth.fail_for.add(USER)
    result = run_account_deletion(ctx, batch_size=10, armed=True)
    assert result.failed == 1 and result.deleted == 1
    assert log[-1] == ("auth.delete", OTHER)


def test_rejected_service_key_aborts_the_run():
    ctx, log = _ctx([PendingAccount(USER, "user_request"), PendingAccount(OTHER, "merged_guest")])

    def reject(user_id: str) -> None:
        raise AuthAdminRejectedError("auth admin returned 401")

    ctx.auth.delete_user = reject
    with pytest.raises(AuthAdminRejectedError):
        run_account_deletion(ctx, batch_size=10, armed=True)
    assert ("stamp", OTHER) not in log and all(entry[0] != "auth.delete" for entry in log)


def test_batch_size_caps_the_run():
    ctx, _ = _ctx([PendingAccount(f"{i:08d}-0000-4000-8000-000000000000", "x") for i in range(5)])
    assert run_account_deletion(ctx, batch_size=2, armed=True).considered == 2


# ---------------------------------------------------------------------------
# SupabaseAuthAdmin
# ---------------------------------------------------------------------------


def _admin(status: int = 200, exc: Exception | None = None):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if exc is not None:
            raise exc
        return httpx.Response(status)

    settings = Settings(
        supabase_url="https://proj.supabase.co", supabase_service_role_key="service-key"
    )
    admin = SupabaseAuthAdmin(settings)
    # Keep the production client's base_url, headers and timeout; swap only the transport.
    admin._client._transport = httpx.MockTransport(handler)
    return admin, requests


def test_admin_sends_delete_to_the_admin_users_url_with_service_headers():
    admin, requests = _admin(200)
    admin.delete_user(USER)
    [req] = requests
    assert req.method == "DELETE"
    assert str(req.url) == f"https://proj.supabase.co/auth/v1/admin/users/{USER}"
    assert req.headers["apikey"] == "service-key"
    assert req.headers["authorization"] == "Bearer service-key"
    assert admin._client.timeout.read is not None


def test_admin_404_is_success():
    admin, requests = _admin(404)
    admin.delete_user(USER)
    assert len(requests) == 1


@pytest.mark.parametrize("bad", ["not-a-uuid", f"{USER}/../../users", "../admin", "", None])
def test_admin_invalid_uuid_never_reaches_the_url(bad):
    admin, requests = _admin(200)
    with pytest.raises(AuthAdminRejectedError):
        admin.delete_user(bad)
    assert requests == []


@pytest.mark.parametrize("status", [401, 403, 422])
def test_admin_client_errors_are_non_retriable(status):
    admin, _ = _admin(status)
    with pytest.raises(AuthAdminRejectedError) as info:
        admin.delete_user(USER)
    assert "service-key" not in str(info.value)


@pytest.mark.parametrize(
    "status, exc",
    [(500, None), (503, None), (200, httpx.ReadTimeout("t")), (200, httpx.ConnectError("c"))],
)
def test_admin_5xx_and_timeouts_are_transient(status, exc):
    admin, _ = _admin(status, exc)
    with pytest.raises(AuthAdminTransientError):
        admin.delete_user(USER)


# ---------------------------------------------------------------------------
# PostgresAccountDeletionStore (SQL text and row mapping, no database)
# ---------------------------------------------------------------------------


def test_store_meshes_use_storage_user_id(fake_db):
    store = PostgresAccountDeletionStore(Settings())
    db = fake_db(store, [("s1", GUEST, f"{GUEST}/s1.obj")])
    assert store.get_account_meshes_to_erase(USER) == [AccountMesh("s1", GUEST, f"{GUEST}/s1.obj")]
    assert db.executed == [
        (
            "select scan_id, storage_user_id, mesh_path from get_account_meshes_to_erase(%s)",
            (USER,),
        )
    ]


def test_store_null_storage_owner_raises_not_none_prefix(fake_db):
    store = PostgresAccountDeletionStore(Settings())
    fake_db(store, [("s1", None, None)])
    with pytest.raises(ScanPathError):
        store.get_account_meshes_to_erase(USER)


def test_store_scalar_functions_are_parameterized(fake_db):
    store = PostgresAccountDeletionStore(Settings())
    db = fake_db(store, [(4,)])
    assert store.queue_abandoned_guests(90) == 4
    assert store.stamp_stray_scans_deleted(USER) == 4
    store.mark_mesh_erased("s1")
    assert [params for _, params in db.executed] == [(90,), (USER,), ("s1",)]
    assert [sql for sql, _ in db.executed] == [
        "select queue_abandoned_guests(%s)",
        "select stamp_stray_scans_deleted(%s)",
        "select mark_mesh_erased(%s)",
    ]
