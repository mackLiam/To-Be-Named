from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from zells_pipeline.config import Settings
from zells_pipeline.jobs.retention import (
    PendingMesh,
    RetentionContext,
    run_retention_sweep,
)


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

    def download(self, bucket: str, path: str) -> bytes:
        return self.files[(bucket, path)]

    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None:
        self.files[(bucket, path)] = data

    def delete(self, bucket: str, path: str) -> None:
        if (bucket, path) in self.raise_on:
            raise RuntimeError(f"simulated storage error deleting {bucket}/{path}")
        self.files.pop((bucket, path), None)  # no-op if already absent, like a real 404
        self.deleted.append((bucket, path))


def _pending(scan_id: str, mesh_path: str) -> PendingMesh:
    return PendingMesh(
        scan_id=scan_id, mesh_path=mesh_path, job_completed_at="2026-06-01T00:00:00Z"
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
