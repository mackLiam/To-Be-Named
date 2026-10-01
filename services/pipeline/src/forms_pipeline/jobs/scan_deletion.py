"""Purge of owner-deleted scans (supabase/migrations/0011_scan_deletion.sql).

A user deleting a scan only stamps scans.deleted_at (clients have no storage
DELETE policy, 0003). This sweep, run with the service role, does the erasing:
every storage object under the scan's prefix plus its mesh_path, then the scans
row, which cascades its measurements and pipeline_jobs, together with any dead
(cancelled, never paid) order on it (purge_scan_row, 0015).
get_scans_pending_purge never returns a scan on a live order or with a running
job.

Irreversible deletion of (often minors') body-scan data, so it is dry run
unless an operator passes --arm (root CLAUDE.md playbook rule 5: never infer
permission to destroy). It is a separate entry point rather than a flag on
the retention sweep because the two are armed independently.

Same shape as jobs/retention.py: fail-the-item-never-the-worker, and
idempotent by construction (storage 404 is success; the row delete is guarded
by deleted_at, so a re-run after a crash between the two steps converges).
Logs scan ids only, never paths, which embed the owning user id.
"""

from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass
from typing import Protocol

from forms_pipeline.config import Settings, get_settings
from forms_pipeline.jobs.runner import (
    StorageClient,
    SupabaseStorageClient,
    owned_mesh_path,
    storage_owner,
)

logger = logging.getLogger(__name__)

MESH_BUCKET = "meshes"
PURGE_ACTOR = "scan-deletion-worker"


@dataclass(frozen=True)
class PendingPurge:
    """One row returned by `get_scans_pending_purge`."""

    scan_id: str
    storage_user_id: str
    mesh_path: str | None


@dataclass(frozen=True)
class PurgeResult:
    considered: int
    purged: int
    failed: int
    armed: bool


class PurgeStore(Protocol):
    def get_scans_pending_purge(self, limit: int) -> list[PendingPurge]: ...
    def delete_scan(self, scan_id: str) -> None: ...


@dataclass
class PurgeContext:
    store: PurgeStore
    storage: StorageClient


def run_scan_purge(ctx: PurgeContext, batch_size: int, armed: bool = False) -> PurgeResult:
    pending = ctx.store.get_scans_pending_purge(limit=batch_size)

    purged = 0
    failed = 0
    for item in pending:
        if not armed:
            logger.info("[DRY_RUN] would purge deleted scan=%s", item.scan_id)
            continue
        try:
            _purge_one(ctx, item)
        except Exception:  # noqa: BLE001 - intentional: fail-the-item-never-the-worker
            logger.exception("scan purge: failed for scan=%s", item.scan_id)
            failed += 1
            continue
        purged += 1

    result = PurgeResult(considered=len(pending), purged=purged, failed=failed, armed=armed)
    logger.info(
        "scan purge: considered=%d purged=%d failed=%d armed=%s",
        result.considered,
        result.purged,
        result.failed,
        result.armed,
    )
    return result


def erase_scan_objects(
    storage: StorageClient, storage_user_id: str, scan_id: str, mesh_path: str | None
) -> None:
    """Delete every object under `<storage_user_id>/<scan_id>/` plus mesh_path.
    Storage 404 is success, so a re-run converges."""
    # Validate before deleting anything: mesh_path is client-writable, and the
    # service role would otherwise delete another user's object.
    owned = owned_mesh_path(storage_user_id, mesh_path) if mesh_path else None
    for path in storage.list(MESH_BUCKET, f"{storage_user_id}/{scan_id}/"):
        storage.delete(MESH_BUCKET, path)
    if owned:
        storage.delete(MESH_BUCKET, owned)


def _purge_one(ctx: PurgeContext, item: PendingPurge) -> None:
    erase_scan_objects(ctx.storage, item.storage_user_id, item.scan_id, item.mesh_path)
    # Last: once the row is gone the scan never reappears in a batch, so
    # storage must already be clean.
    ctx.store.delete_scan(item.scan_id)


class PostgresPurgeStore:
    """PurgeStore over `get_scans_pending_purge` and parameterized SQL, in the
    style of `jobs.retention.PostgresRetentionStore`."""

    def __init__(self, settings: Settings | None = None):
        import psycopg  # local import: keeps psycopg optional for pure-unit tests

        self._psycopg = psycopg
        self._settings = settings or get_settings()

    def _connect(self):  # noqa: ANN202 - psycopg.Connection typing needs the optional import
        return self._psycopg.connect(self._settings.database_url.get_secret_value())

    def get_scans_pending_purge(self, limit: int) -> list[PendingPurge]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "select scan_id, storage_user_id, mesh_path from get_scans_pending_purge(%s)",
                (limit,),
            )
            rows = cur.fetchall()
        return [
            PendingPurge(scan_id=str(r[0]), storage_user_id=storage_owner(r[1]), mesh_path=r[2])
            for r in rows
        ]

    def delete_scan(self, scan_id: str) -> None:
        """Delete the row, its dead (cancelled, never paid) orders and their
        audit rows in one transaction via purge_scan_row (0015). Idempotent: a
        repeat, or a scan a live order now holds, returns false and changes
        nothing."""
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("select purge_scan_row(%s, %s)", (scan_id, PURGE_ACTOR))
            row = cur.fetchone()
            conn.commit()
        if not (row and row[0]):
            logger.info("scan purge: scan=%s no longer eligible, row kept", scan_id)


def main(argv: list[str] | None = None) -> None:  # pragma: no cover - thin wiring
    parser = argparse.ArgumentParser(description="Erase scans their owners deleted.")
    parser.add_argument(
        "--arm",
        action="store_true",
        help="Actually erase. Without it the sweep only logs what it would purge.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO)
    settings = get_settings()
    ctx = PurgeContext(store=PostgresPurgeStore(settings), storage=SupabaseStorageClient(settings))
    run_scan_purge(ctx, batch_size=settings.retention_batch_size, armed=args.arm)


if __name__ == "__main__":  # pragma: no cover
    main()
