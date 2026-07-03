"""Raw-mesh retention sweep (docs/DESIGN.md section 9.3, docs/ROADMAP.md week 8).

Raw uploaded meshes are sensitive body-scan data. Policy: once a scan's
pipeline job has completed, the raw mesh has served its purpose (measurement
extraction) and is auto-deleted `RETENTION_DAYS` later; the measurements JSON
row is kept forever (docs/DESIGN.md section 5: reordering only ever needs
measurements, never the raw mesh). This is both a privacy control and a
storage cost control (meshes run 10-100 MB each).

Fail-the-item-never-the-worker (same principle as jobs/runner.py): one bad
scan (missing object, transient storage error) must never abort the whole
sweep. Idempotent by construction:
- `get_meshes_pending_deletion` (supabase/migrations/0004_retention.sql)
  only returns scans where `mesh_deleted_at is null`, so an already-deleted
  scan never reappears in a later batch.
- Storage deletion is itself idempotent: a 404 (object already gone --
  e.g. a prior run deleted the object but crashed before marking the row)
  is treated as success, not a failure, so a retry always converges.

This module is invoked as a standalone entry point (`python -m
zells_pipeline.jobs.retention`), not as a background thread inside the
always-on worker process (see `jobs/runner.py`'s `run_forever`). Retention is
a daily-cadence batch maintenance task, not a queue consumer: running it as
a separate process invocation lets it be scheduled independently (a nightly
cron / scheduled machine on the deployed worker, per the docstring in
docs/ROADMAP.md week 8) without adding a second timer loop and shutdown path
to `main.py`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

from zells_pipeline.config import Settings, get_settings
from zells_pipeline.jobs.runner import StorageClient, SupabaseStorageClient

logger = logging.getLogger(__name__)

MESH_BUCKET = "meshes"
RETENTION_ACTOR = "retention-worker"


@dataclass(frozen=True)
class PendingMesh:
    """One row returned by `get_meshes_pending_deletion`."""

    scan_id: str
    mesh_path: str
    job_completed_at: datetime | str | None


@dataclass(frozen=True)
class RetentionSweepResult:
    considered: int
    deleted: int
    failed: int
    dry_run: bool


class RetentionStore(Protocol):
    """Database access needed by the retention sweep. Implemented for real
    by `PostgresRetentionStore`; faked in tests."""

    def get_meshes_pending_deletion(self, retention_days: int, limit: int) -> list[PendingMesh]: ...
    def mark_mesh_deleted(self, scan_id: str, detail: dict[str, Any] | None = None) -> None: ...


@dataclass
class RetentionContext:
    store: RetentionStore
    storage: StorageClient


def run_retention_sweep(
    ctx: RetentionContext,
    retention_days: int,
    batch_size: int,
    dry_run: bool = True,
) -> RetentionSweepResult:
    """Delete raw meshes for scans whose job completed more than
    `retention_days` ago, up to `batch_size` per run.

    In dry-run mode (the default -- see `Settings.retention_dry_run`), only
    the read-only batch fetch happens; no storage or database mutation is
    made. Never logs `mesh_path` (it embeds the owning user_id as a storage
    path prefix, per supabase/migrations/0003_storage.sql) -- only scan_id
    and the completion timestamp, which is enough to audit the sweep without
    putting scan-owning-user identifiers in worker logs.
    """
    pending = ctx.store.get_meshes_pending_deletion(retention_days=retention_days, limit=batch_size)

    deleted = 0
    failed = 0
    for item in pending:
        if dry_run:
            logger.info(
                "[DRY_RUN] would delete mesh for scan=%s (job completed %s)",
                item.scan_id,
                item.job_completed_at,
            )
            continue

        try:
            _delete_one(ctx, item)
        except Exception:  # noqa: BLE001 - intentional: fail-the-item-never-the-worker
            logger.exception("retention: failed to delete mesh for scan=%s", item.scan_id)
            failed += 1
            continue
        deleted += 1

    result = RetentionSweepResult(
        considered=len(pending), deleted=deleted, failed=failed, dry_run=dry_run
    )
    logger.info(
        "retention sweep: considered=%d deleted=%d failed=%d dry_run=%s",
        result.considered,
        result.deleted,
        result.failed,
        result.dry_run,
    )
    return result


def _delete_one(ctx: RetentionContext, item: PendingMesh) -> None:
    ctx.storage.delete(MESH_BUCKET, item.mesh_path)
    ctx.store.mark_mesh_deleted(
        scan_id=item.scan_id,
        detail={
            "job_completed_at": str(item.job_completed_at) if item.job_completed_at else None,
        },
    )


# ---------------------------------------------------------------------------
# Production implementation of RetentionStore.
# ---------------------------------------------------------------------------


class PostgresRetentionStore:
    """RetentionStore backed by `get_meshes_pending_deletion`
    (supabase/migrations/0004_retention.sql) and plain parameterized SQL,
    matching the style of `jobs.runner.PostgresJobStore`. Every query is
    parameterized; no string-built SQL, ever.
    """

    def __init__(self, settings: Settings | None = None):
        import psycopg  # local import: keeps psycopg optional for pure-unit tests

        self._psycopg = psycopg
        self._settings = settings or get_settings()

    def _connect(self):  # noqa: ANN202 - psycopg.Connection typing needs the optional import
        return self._psycopg.connect(self._settings.database_url.get_secret_value())

    def get_meshes_pending_deletion(self, retention_days: int, limit: int) -> list[PendingMesh]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "select scan_id, mesh_path, job_completed_at "
                "from get_meshes_pending_deletion(%s, %s)",
                (retention_days, limit),
            )
            rows = cur.fetchall()
        return [
            PendingMesh(scan_id=str(r[0]), mesh_path=str(r[1]), job_completed_at=r[2]) for r in rows
        ]

    def mark_mesh_deleted(self, scan_id: str, detail: dict[str, Any] | None = None) -> None:
        """Mark the scan's mesh deleted and write an audit_log row, atomically.

        Idempotent: the `mesh_deleted_at is null` guard means a second call
        for an already-marked scan updates zero rows and skips the audit
        insert, so re-running never produces duplicate audit entries.
        """
        import json

        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "update public.scans set mesh_deleted_at = now() "
                "where id = %s and mesh_deleted_at is null "
                "returning id",
                (scan_id,),
            )
            newly_marked = cur.fetchone() is not None
            if newly_marked:
                cur.execute(
                    "insert into public.audit_log "
                    "(actor, action, subject_table, subject_id, detail) "
                    "values (%s, %s, %s, %s, %s)",
                    (
                        RETENTION_ACTOR,
                        "mesh_deleted",
                        "scans",
                        scan_id,
                        json.dumps(detail) if detail else None,
                    ),
                )
            conn.commit()


# ---------------------------------------------------------------------------
# Entry point: `python -m zells_pipeline.jobs.retention`.
# ---------------------------------------------------------------------------


def main() -> None:  # pragma: no cover - thin wiring, exercised via run_retention_sweep tests
    logging.basicConfig(level=logging.INFO)
    settings = get_settings()
    ctx = RetentionContext(
        store=PostgresRetentionStore(settings),
        storage=SupabaseStorageClient(settings),
    )
    run_retention_sweep(
        ctx,
        retention_days=settings.retention_days,
        batch_size=settings.retention_batch_size,
        dry_run=settings.retention_dry_run,
    )


if __name__ == "__main__":  # pragma: no cover
    main()
