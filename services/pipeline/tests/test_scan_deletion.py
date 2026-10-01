from dataclasses import dataclass, field

import pytest

from forms_pipeline.config import Settings
from forms_pipeline.jobs.runner import ScanPathError
from forms_pipeline.jobs.scan_deletion import (
    MESH_BUCKET,
    PendingPurge,
    PostgresPurgeStore,
    PurgeContext,
    run_scan_purge,
)

USER = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"


@dataclass
class FakeStorageClient:
    """In-memory storage: delete of a missing object succeeds, like a real 404."""

    files: dict[tuple[str, str], bytes] = field(default_factory=dict)
    deleted: list[tuple[str, str]] = field(default_factory=list)
    raise_on: set[tuple[str, str]] = field(default_factory=set)

    def download(self, bucket: str, path: str) -> bytes:
        return self.files[(bucket, path)]

    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None:
        self.files[(bucket, path)] = data

    def delete(self, bucket: str, path: str) -> None:
        if (bucket, path) in self.raise_on:
            raise RuntimeError("simulated storage error")
        self.files.pop((bucket, path), None)
        self.deleted.append((bucket, path))

    def list(self, bucket: str, prefix: str) -> list[str]:
        return sorted(p for b, p in self.files if b == bucket and p.startswith(prefix))


@dataclass
class FakePurgeStore:
    """Mirrors get_scans_pending_purge: a purged row drops out of later batches."""

    items: list[PendingPurge] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)

    def get_scans_pending_purge(self, limit: int) -> list[PendingPurge]:
        return [i for i in self.items if i.scan_id not in self.deleted][:limit]

    def delete_scan(self, scan_id: str) -> None:
        if scan_id not in self.deleted:
            self.deleted.append(scan_id)


def _ctx(items, files):
    storage = FakeStorageClient(files={(MESH_BUCKET, p): b"x" for p in files})
    return PurgeContext(store=FakePurgeStore(items=items), storage=storage), storage


def test_dry_run_by_default_touches_nothing():
    ctx, storage = _ctx([PendingPurge("s1", USER, f"{USER}/s1.obj")], [f"{USER}/s1.obj"])
    result = run_scan_purge(ctx, batch_size=10)
    assert result.considered == 1 and result.purged == 0 and not result.armed
    assert storage.deleted == []
    assert ctx.store.deleted == []


def test_armed_erases_mesh_photo_bundle_then_row():
    files = [f"{USER}/s1.obj", f"{USER}/s2/0001.heic", f"{USER}/s2/0002.heic", f"{USER}/keep.obj"]
    ctx, storage = _ctx(
        [PendingPurge("s1", USER, f"{USER}/s1.obj"), PendingPurge("s2", USER, None)], files
    )
    result = run_scan_purge(ctx, batch_size=10, armed=True)
    assert result.purged == 2 and result.failed == 0
    assert sorted(p for _, p in storage.files) == [f"{USER}/keep.obj"]
    assert ctx.store.deleted == ["s1", "s2"]


def test_foreign_mesh_path_is_refused_and_row_kept():
    # mesh_path is client-writable; a path in another user's prefix must never
    # be deleted by the service role.
    ctx, storage = _ctx([PendingPurge("s1", USER, f"{OTHER}/theirs.obj")], [f"{OTHER}/theirs.obj"])
    result = run_scan_purge(ctx, batch_size=10, armed=True)
    assert result.failed == 1 and result.purged == 0
    assert (MESH_BUCKET, f"{OTHER}/theirs.obj") in storage.files
    assert ctx.store.deleted == []


def test_one_storage_failure_does_not_stop_the_batch_and_keeps_its_row():
    ctx, storage = _ctx(
        [PendingPurge("s1", USER, f"{USER}/s1.obj"), PendingPurge("s2", USER, f"{USER}/s2.obj")],
        [f"{USER}/s1.obj", f"{USER}/s2.obj"],
    )
    storage.raise_on.add((MESH_BUCKET, f"{USER}/s1.obj"))
    result = run_scan_purge(ctx, batch_size=10, armed=True)
    assert result.failed == 1 and result.purged == 1
    assert ctx.store.deleted == ["s2"]


def test_rerun_converges_when_objects_are_already_gone():
    ctx, _ = _ctx([PendingPurge("s1", USER, f"{USER}/s1.obj")], [])
    assert run_scan_purge(ctx, batch_size=10, armed=True).purged == 1
    assert run_scan_purge(ctx, batch_size=10, armed=True).considered == 0


def test_batch_size_caps_the_run():
    items = [PendingPurge(f"s{i}", USER, None) for i in range(5)]
    ctx, _ = _ctx(items, [])
    assert run_scan_purge(ctx, batch_size=2, armed=True).purged == 2


GUEST = "33333333-3333-4333-8333-333333333333"


def test_merged_scan_is_purged_under_storage_owner():
    files = [f"{GUEST}/s1.obj", f"{GUEST}/s1/000.jpg", f"{USER}/s1/000.jpg"]
    ctx, storage = _ctx([PendingPurge("s1", GUEST, f"{GUEST}/s1.obj")], files)
    assert run_scan_purge(ctx, batch_size=10, armed=True).purged == 1
    # Only the storage owner's objects go; the current owner's prefix is untouched.
    assert sorted(p for _, p in storage.files) == [f"{USER}/s1/000.jpg"]


def test_store_selects_storage_user_id(fake_db):
    store = PostgresPurgeStore(Settings())
    db = fake_db(store, [("s1", GUEST, None)])
    assert store.get_scans_pending_purge(limit=5) == [PendingPurge("s1", GUEST, None)]
    assert db.executed[0][0].startswith("select scan_id, storage_user_id, mesh_path")


def test_store_null_storage_owner_raises_not_none_prefix(fake_db):
    store = PostgresPurgeStore(Settings())
    fake_db(store, [("s1", None, None)])
    with pytest.raises(ScanPathError):
        store.get_scans_pending_purge(limit=5)
