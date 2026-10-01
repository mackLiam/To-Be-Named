from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from forms_pipeline.config import Settings
from forms_pipeline.jobs.retention import (
    PendingMesh,
    PostgresRetentionStore,
    RetentionContext,
    run_retention_sweep,
)
from forms_pipeline.jobs.runner import ScanPathError


@dataclass
class FakeRetentionStore:
    """In-memory RetentionStore fake: no network, no real Postgres.

    `get_meshes_pending_deletion` mimics the SQL helper's contract
    (supabase/migrations/0004_retention.sql): LIMIT-capped, and rows drop out
    once `mark_mesh_deleted` has been called for them (mirroring the SQL
    function's `mesh_deleted_at is null` filter) -- that's what makes a
    re-run of the sweep idempotent in these tests, the same way it is against
    the real database.
    """

    items: list[PendingMesh] = field(default_factory=list)
    marked: list[tuple[str, dict[str, Any] | None]] = field(default_factory=list)
    fetch_calls: list[tuple[int, int]] = field(default_factory=list)

    def get_meshes_pending_deletion(self, retention_days: int, limit: int) -> list[PendingMesh]:
        self.fetch_calls.append((retention_days, limit))
        return list(self.items[:limit])

    def mark_mesh_deleted(self, scan_id: str, detail: dict[str, Any] | None = None) -> None:
        self.marked.append((scan_id, detail))
        self.items = [item for item in self.items if item.scan_id != scan_id]


@dataclass
class FakeStorageClient:
    """In-memory StorageClient fake keyed by (bucket, path).

    `delete` mirrors `SupabaseStorageClient.delete`'s real idempotency
    contract: deleting an object that isn't present (already gone) succeeds
    silently rather than raising, matching "storage 404 == success".
    `raise_on` lets a test simulate a genuine (non-404) storage failure for
    a specific object.
    """

    files: dict[tuple[str, str], bytes] = field(default_factory=dict)
    deleted: list[tuple[str, str]] = field(default_factory=list)
    raise_on: set[tuple[str, str]] = field(default_factory=set)
    listed: list[tuple[str, str]] = field(default_factory=list)

    def download(self, bucket: str, path: str) -> bytes:
        return self.files[(bucket, path)]

    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None:
        self.files[(bucket, path)] = data

    def delete(self, bucket: str, path: str) -> None:
        if (bucket, path) in self.raise_on:
            raise RuntimeError(f"simulated storage error deleting {bucket}/{path}")
        self.files.pop((bucket, path), None)  # no-op if already absent, like a real 404
        self.deleted.append((bucket, path))

    def list(self, bucket: str, prefix: str) -> list[str]:
        self.listed.append((bucket, prefix))
        return sorted(p for b, p in self.files if b == bucket and p.startswith(prefix))


def _pending(scan_id: str, mesh_path: str, storage_user_id: str | None = None) -> PendingMesh:
    return PendingMesh(
        scan_id=scan_id,
        storage_user_id=storage_user_id or mesh_path.split("/")[0],
        mesh_path=mesh_path,
        job_completed_at="2026-06-01T00:00:00Z",
    )


def test_settings_retention_defaults() -> None:
    settings = Settings()
    assert settings.retention_days == 30
    assert settings.retention_batch_size == 100
    assert settings.retention_dry_run is True  # safe by default: irreversible deletion


def test_happy_path_deletes_marks_and_audits() -> None:
    store = FakeRetentionStore(
        items=[_pending("scan-1", "user-1/scan-1.obj"), _pending("scan-2", "user-2/scan-2.obj")]
    )
    storage = FakeStorageClient(
        files={
            ("meshes", "user-1/scan-1.obj"): b"mesh-1",
            ("meshes", "user-2/scan-2.obj"): b"mesh-2",
        }
    )
    ctx = RetentionContext(store=store, storage=storage)

    result = run_retention_sweep(ctx, retention_days=30, batch_size=100, dry_run=False)

    assert result.considered == 2
    assert result.deleted == 2
    assert result.failed == 0
    assert ("meshes", "user-1/scan-1.obj") in storage.deleted
    assert ("meshes", "user-2/scan-2.obj") in storage.deleted
    marked_scan_ids = {scan_id for scan_id, _ in store.marked}
    assert marked_scan_ids == {"scan-1", "scan-2"}
    # A detail payload is passed for the audit_log row the real
    # PostgresRetentionStore writes alongside the mesh_deleted_at update.
    assert all(detail is not None for _, detail in store.marked)
    # Deleted scans drop out of the eligible set, per the SQL helper's
    # mesh_deleted_at is null filter.
    assert store.items == []


def test_storage_object_already_gone_is_treated_as_success_and_marked() -> None:
    """Simulates a prior sweep run that deleted the storage object but crashed
    before marking the row: the object is absent from storage, but deletion
    must still succeed (idempotent) and the row still gets marked."""
    store = FakeRetentionStore(items=[_pending("scan-1", "user-1/scan-1.obj")])
    storage = FakeStorageClient(files={})  # object already gone
    ctx = RetentionContext(store=store, storage=storage)

    result = run_retention_sweep(ctx, retention_days=30, batch_size=100, dry_run=False)

    assert result.deleted == 1
    assert result.failed == 0
    assert store.marked[0][0] == "scan-1"


def test_per_item_failure_continues_the_batch() -> None:
    store = FakeRetentionStore(
        items=[_pending("scan-bad", "user-1/bad.obj"), _pending("scan-good", "user-2/good.obj")]
    )
    storage = FakeStorageClient(
        files={
            ("meshes", "user-1/bad.obj"): b"mesh-bad",
            ("meshes", "user-2/good.obj"): b"mesh-good",
        },
        raise_on={("meshes", "user-1/bad.obj")},
    )
    ctx = RetentionContext(store=store, storage=storage)

    result = run_retention_sweep(ctx, retention_days=30, batch_size=100, dry_run=False)

    assert result.considered == 2
    assert result.deleted == 1
    assert result.failed == 1
    assert [scan_id for scan_id, _ in store.marked] == ["scan-good"]
    # The failed item was never marked deleted, so it remains eligible for
    # the next run rather than being silently dropped.
    assert [item.scan_id for item in store.items] == ["scan-bad"]


def test_dry_run_touches_nothing() -> None:
    store = FakeRetentionStore(items=[_pending("scan-1", "user-1/scan-1.obj")])
    storage = FakeStorageClient(files={("meshes", "user-1/scan-1.obj"): b"mesh-1"})
    ctx = RetentionContext(store=store, storage=storage)

    result = run_retention_sweep(ctx, retention_days=30, batch_size=100, dry_run=True)

    assert result.considered == 1
    assert result.deleted == 0
    assert result.failed == 0
    assert result.dry_run is True
    assert storage.deleted == []
    assert storage.listed == []
    assert store.marked == []
    # The read-only fetch still happens (needed to log what dry-run would do)...
    assert store.fetch_calls == [(30, 100)]
    # ...but nothing was mutated: the item is still eligible.
    assert len(store.items) == 1


def test_batch_limit_is_respected() -> None:
    store = FakeRetentionStore(
        items=[_pending(f"scan-{i}", f"user-{i}/scan-{i}.obj") for i in range(5)]
    )
    storage = FakeStorageClient(
        files={("meshes", f"user-{i}/scan-{i}.obj"): b"mesh" for i in range(5)}
    )
    ctx = RetentionContext(store=store, storage=storage)

    result = run_retention_sweep(ctx, retention_days=30, batch_size=2, dry_run=False)

    assert store.fetch_calls == [(30, 2)]
    assert result.considered == 2
    assert result.deleted == 2
    # 3 of the 5 remain untouched, ready for the next run's batch.
    assert len(store.items) == 3


def test_idempotent_rerun_never_double_deletes_or_errors() -> None:
    store = FakeRetentionStore(items=[_pending("scan-1", "user-1/scan-1.obj")])
    storage = FakeStorageClient(files={("meshes", "user-1/scan-1.obj"): b"mesh-1"})
    ctx = RetentionContext(store=store, storage=storage)

    first = run_retention_sweep(ctx, retention_days=30, batch_size=100, dry_run=False)
    second = run_retention_sweep(ctx, retention_days=30, batch_size=100, dry_run=False)

    assert first.deleted == 1
    assert second.considered == 0
    assert second.deleted == 0
    assert second.failed == 0
    assert storage.deleted.count(("meshes", "user-1/scan-1.obj")) == 1
    assert len(store.marked) == 1


def test_photo_bundle_prefix_deleted_with_mesh() -> None:
    bundle = [
        "user-1/scan-1/capture.json",
        "user-1/scan-1/images/000.jpg",
        "user-1/scan-1/images/001.jpg",
    ]
    store = FakeRetentionStore(items=[_pending("scan-1", "user-1/scan-1.obj")])
    storage = FakeStorageClient(
        files={
            ("meshes", "user-1/scan-1.obj"): b"mesh",
            # Same user, other scan whose name shares the scan-1 prefix: must survive.
            ("meshes", "user-1/scan-10/capture.json"): b"other",
            **{("meshes", p): b"x" for p in bundle},
        }
    )
    ctx = RetentionContext(store=store, storage=storage)

    result = run_retention_sweep(ctx, retention_days=30, batch_size=100, dry_run=False)

    assert result.deleted == 1
    assert storage.listed == [("meshes", "user-1/scan-1/")]
    assert {p for _, p in storage.deleted} == {*bundle, "user-1/scan-1.obj"}
    assert list(storage.files) == [("meshes", "user-1/scan-10/capture.json")]
    assert [scan_id for scan_id, _ in store.marked] == ["scan-1"]


def test_foreign_mesh_path_deletes_nothing_and_is_not_marked() -> None:
    # scans.mesh_path is client-writable: a path into another user's prefix
    # must never be deleted by the service-role sweep.
    store = FakeRetentionStore(
        items=[_pending("scan-1", "user-2/scan-9.obj", storage_user_id="user-1")]
    )
    storage = FakeStorageClient(files={("meshes", "user-2/scan-9.obj"): b"theirs"})
    ctx = RetentionContext(store=store, storage=storage)

    result = run_retention_sweep(ctx, retention_days=30, batch_size=100, dry_run=False)

    assert result.failed == 1
    assert result.deleted == 0
    assert storage.deleted == []
    assert ("meshes", "user-2/scan-9.obj") in storage.files
    assert store.marked == []


def test_listing_failure_leaves_scan_unmarked_for_retry() -> None:
    class FailingList(FakeStorageClient):
        def list(self, bucket: str, prefix: str) -> list[str]:
            raise RuntimeError("storage list exceeded")

    store = FakeRetentionStore(items=[_pending("scan-1", "user-1/scan-1.obj")])
    storage = FailingList(files={("meshes", "user-1/scan-1.obj"): b"mesh"})
    ctx = RetentionContext(store=store, storage=storage)

    result = run_retention_sweep(ctx, retention_days=30, batch_size=100, dry_run=False)

    assert result.failed == 1
    assert store.marked == []
    assert ("meshes", "user-1/scan-1.obj") in storage.files


GUEST = "33333333-3333-4333-8333-333333333333"


def test_merged_scan_is_erased_under_storage_owner() -> None:
    # A merged scan's row now belongs to the member, but its objects are under
    # the guest's prefix; that prefix is the one listed and erased.
    store = FakeRetentionStore(items=[_pending("scan-1", f"{GUEST}/scan-1.obj")])
    storage = FakeStorageClient(
        files={("meshes", f"{GUEST}/scan-1.obj"): b"m", ("meshes", f"{GUEST}/scan-1/0.jpg"): b"p"}
    )
    ctx = RetentionContext(store=store, storage=storage)

    result = run_retention_sweep(ctx, retention_days=30, batch_size=100, dry_run=False)

    assert result.deleted == 1
    assert storage.listed == [("meshes", f"{GUEST}/scan-1/")]
    assert storage.files == {}


def test_store_joins_storage_user_id_tolerating_null_owner(fake_db) -> None:
    # The scan's user_id may be null (account deleted) or another user (merged);
    # the query never reads it.
    store = PostgresRetentionStore(Settings())
    db = fake_db(store, [("scan-1", GUEST, f"{GUEST}/scan-1.obj", None)])
    [item] = store.get_meshes_pending_deletion(retention_days=30, limit=10)
    sql = db.executed[0][0]
    assert "s.storage_user_id" in sql and "s.user_id" not in sql
    assert item.storage_user_id == GUEST


def test_store_null_storage_owner_raises_not_none_prefix(fake_db) -> None:
    store = PostgresRetentionStore(Settings())
    fake_db(store, [("scan-1", None, "None/scan-1.obj", None)])
    with pytest.raises(ScanPathError):
        store.get_meshes_pending_deletion(retention_days=30, limit=10)


def test_photos_scan_without_mesh_erases_prefix_only() -> None:
    # 0015: a photos scan whose reconstruction failed has no mesh_path; its
    # bundle is still erased and no single-object delete is attempted.
    item = PendingMesh(
        scan_id="scan-1", storage_user_id="user-1", mesh_path=None, job_completed_at=None
    )
    store = FakeRetentionStore(items=[item])
    storage = FakeStorageClient(
        files={
            ("meshes", "user-1/scan-1/images/000.jpg"): b"x",
            ("meshes", "user-1/scan-1/images/001.jpg"): b"x",
        }
    )
    ctx = RetentionContext(store=store, storage=storage)

    result = run_retention_sweep(ctx, retention_days=30, batch_size=100, dry_run=False)

    assert result.deleted == 1 and result.failed == 0
    assert storage.files == {}
    assert {p for _, p in storage.deleted} == {
        "user-1/scan-1/images/000.jpg",
        "user-1/scan-1/images/001.jpg",
    }
    assert [scan_id for scan_id, _ in store.marked] == ["scan-1"]


def test_store_keeps_null_mesh_path_as_none(fake_db) -> None:
    store = PostgresRetentionStore(Settings())
    fake_db(store, [("scan-1", GUEST, None, None)])
    [item] = store.get_meshes_pending_deletion(retention_days=30, limit=10)
    assert item.mesh_path is None
