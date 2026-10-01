"""Account deletion (supabase/migrations/0012_account_security.sql, plan D4/D5/A6).

request_account_deletion() (or a guest merge, or the abandoned-guest sweep)
only records a request and stamps the account's unordered scans deleted. This
worker, run with the service role, finishes the job per account: erase the
storage objects of the scans that are kept (ordered scans: the row stays for
the order record, the body-scan files do not), then delete the auth user via
the Admin API, which nulls scans/orders.user_id and cascades the request row.

Irreversible deletion of (often minors') body-scan data and accounts, so it is
dry run unless an operator passes --arm (root CLAUDE.md playbook rule 5).
Separate entry point from jobs/scan_deletion.py: armed independently, and the
scan purge must run first (an account with stamped scans is not returned by
get_accounts_pending_deletion until the purge has erased them).

Fail-the-item-never-the-worker; idempotent by construction (storage 404 and
Admin API 404 are success, get_account_meshes_to_erase skips erased meshes).
Logs user and scan ids only, never emails or paths.
"""

from __future__ import annotations

import argparse
import logging
import uuid
from dataclasses import dataclass
from typing import Protocol

import httpx

from forms_pipeline.config import Settings, get_settings
from forms_pipeline.jobs.runner import StorageClient, SupabaseStorageClient, storage_owner
from forms_pipeline.jobs.scan_deletion import erase_scan_objects

logger = logging.getLogger(__name__)

DEFAULT_GUEST_IDLE_DAYS = 90
ADMIN_TIMEOUT_S = 30.0


class AuthAdminRejectedError(RuntimeError):
    """Non-retriable: the Admin API refused the request (401/403 means the
    service role key is wrong or missing). Retrying with the same config fails."""


class AuthAdminTransientError(RuntimeError):
    """Presumed transient (5xx, timeout, connection error): the next run retries."""


@dataclass(frozen=True)
class PendingAccount:
    """One row returned by `get_accounts_pending_deletion`."""

    user_id: str
    reason: str


@dataclass(frozen=True)
class AccountMesh:
    """One row returned by `get_account_meshes_to_erase`."""

    scan_id: str
    storage_user_id: str
    mesh_path: str | None


@dataclass(frozen=True)
class AccountDeletionResult:
    considered: int
    deleted: int
    skipped: int
    failed: int
    # None when the guest sweep did not run (dry run).
    guests_queued: int | None
    armed: bool


class AccountDeletionStore(Protocol):
    def queue_abandoned_guests(self, idle_days: int) -> int: ...
    def get_accounts_pending_deletion(self, limit: int) -> list[PendingAccount]: ...
    def stamp_stray_scans_deleted(self, user_id: str) -> int: ...
    def get_account_meshes_to_erase(self, user_id: str) -> list[AccountMesh]: ...
    def mark_mesh_erased(self, scan_id: str) -> None: ...


class AuthAdmin(Protocol):
    def delete_user(self, user_id: str) -> None: ...


@dataclass
class AccountDeletionContext:
    store: AccountDeletionStore
    storage: StorageClient
    auth: AuthAdmin


def run_account_deletion(
    ctx: AccountDeletionContext,
    batch_size: int,
    armed: bool = False,
    guest_idle_days: int = DEFAULT_GUEST_IDLE_DAYS,
) -> AccountDeletionResult:
    guests_queued: int | None = None
    if armed:
        guests_queued = ctx.store.queue_abandoned_guests(guest_idle_days)
    else:
        # queue_abandoned_guests writes (stamps scans, inserts requests), and the
        # contract has no read-only count, so the dry run skips it.
        logger.info("[DRY_RUN] abandoned-guest sweep skipped (it writes)")

    pending = ctx.store.get_accounts_pending_deletion(limit=batch_size)
    deleted = skipped = failed = 0
    for account in pending:
        if not armed:
            logger.info(
                "[DRY_RUN] would delete account user=%s reason=%s", account.user_id, account.reason
            )
            continue
        try:
            done = _delete_one(ctx, account)
        except AuthAdminRejectedError:
            # A rejected service key fails every user the same way; stop before
            # erasing more meshes for accounts this run cannot delete.
            raise
        except Exception:  # noqa: BLE001 - intentional: fail-the-item-never-the-worker
            logger.exception("account deletion: failed for user=%s", account.user_id)
            failed += 1
            continue
        if done:
            deleted += 1
        else:
            skipped += 1

    result = AccountDeletionResult(
        considered=len(pending),
        deleted=deleted,
        skipped=skipped,
        failed=failed,
        guests_queued=guests_queued,
        armed=armed,
    )
    logger.info(
        "account deletion: considered=%d deleted=%d skipped=%d failed=%d guests_queued=%s armed=%s",
        result.considered,
        result.deleted,
        result.skipped,
        result.failed,
        result.guests_queued,
        result.armed,
    )
    return result


def _delete_one(ctx: AccountDeletionContext, account: PendingAccount) -> bool:
    """True when the auth user is gone; False when skipped for this run."""
    stray = ctx.store.stamp_stray_scans_deleted(account.user_id)
    if stray > 0:
        # Scans created after the request: the scan purge erases them first.
        logger.info("account deletion: user=%s has %d stray scans, skipped", account.user_id, stray)
        return False
    for mesh in ctx.store.get_account_meshes_to_erase(account.user_id):
        erase_scan_objects(ctx.storage, mesh.storage_user_id, mesh.scan_id, mesh.mesh_path)
        ctx.store.mark_mesh_erased(mesh.scan_id)
    # Last: once the user is gone the request row cascades away and this
    # account never reappears, so its storage must already be clean.
    ctx.auth.delete_user(account.user_id)
    logger.info("account deletion: deleted user=%s", account.user_id)
    return True


class SupabaseAuthAdmin:
    """AuthAdmin over the Supabase Auth Admin API with the service role key,
    sent only in headers, never logged or put in an exception message."""

    def __init__(self, settings: Settings | None = None, client: httpx.Client | None = None):
        self._settings = settings or get_settings()
        key = self._settings.supabase_service_role_key.get_secret_value()
        self._client = client or httpx.Client(
            base_url=f"{self._settings.supabase_url}/auth/v1",
            timeout=ADMIN_TIMEOUT_S,
            headers={"Authorization": f"Bearer {key}", "apikey": key},
        )

    def delete_user(self, user_id: str) -> None:
        # Canonical form only: the id goes into a URL path.
        try:
            uid = str(uuid.UUID(user_id))
        except (ValueError, TypeError, AttributeError) as exc:
            raise AuthAdminRejectedError("user id is not a UUID") from exc
        try:
            response = self._client.delete(f"/admin/users/{uid}")
        except httpx.TransportError as exc:  # timeouts are TransportErrors
            raise AuthAdminTransientError(f"auth admin unreachable: {type(exc).__name__}") from exc
        if response.status_code == 404 or response.is_success:
            return
        if response.status_code >= 500:
            raise AuthAdminTransientError(f"auth admin returned {response.status_code}")
        raise AuthAdminRejectedError(f"auth admin returned {response.status_code}")


class PostgresAccountDeletionStore:
    """AccountDeletionStore over the 0012 service-role functions, parameterized
    SQL only, in the style of `jobs.scan_deletion.PostgresPurgeStore`."""

    def __init__(self, settings: Settings | None = None):
        import psycopg  # local import: keeps psycopg optional for pure-unit tests

        self._psycopg = psycopg
        self._settings = settings or get_settings()

    def _connect(self):  # noqa: ANN202 - psycopg.Connection typing needs the optional import
        return self._psycopg.connect(self._settings.database_url.get_secret_value())

    def _scalar(self, sql: str, params: tuple) -> object:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
            conn.commit()
        return row[0] if row else None

    def queue_abandoned_guests(self, idle_days: int) -> int:
        return int(self._scalar("select queue_abandoned_guests(%s)", (idle_days,)) or 0)

    def get_accounts_pending_deletion(self, limit: int) -> list[PendingAccount]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute("select user_id, reason from get_accounts_pending_deletion(%s)", (limit,))
            rows = cur.fetchall()
        return [PendingAccount(user_id=str(r[0]), reason=r[1]) for r in rows]

    def stamp_stray_scans_deleted(self, user_id: str) -> int:
        return int(self._scalar("select stamp_stray_scans_deleted(%s)", (user_id,)) or 0)

    def get_account_meshes_to_erase(self, user_id: str) -> list[AccountMesh]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "select scan_id, storage_user_id, mesh_path from get_account_meshes_to_erase(%s)",
                (user_id,),
            )
            rows = cur.fetchall()
        return [
            AccountMesh(scan_id=str(r[0]), storage_user_id=storage_owner(r[1]), mesh_path=r[2])
            for r in rows
        ]

    def mark_mesh_erased(self, scan_id: str) -> None:
        self._scalar("select mark_mesh_erased(%s)", (scan_id,))


def main(argv: list[str] | None = None) -> None:  # pragma: no cover - thin wiring
    parser = argparse.ArgumentParser(description="Delete accounts that asked to be deleted.")
    parser.add_argument(
        "--arm",
        action="store_true",
        help="Actually delete. Without it the run only logs what it would delete.",
    )
    parser.add_argument(
        "--guest-idle-days",
        type=int,
        default=DEFAULT_GUEST_IDLE_DAYS,
        help="Queue anonymous guests idle this many days (armed only; the database floor is 30).",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO)
    settings = get_settings()
    ctx = AccountDeletionContext(
        store=PostgresAccountDeletionStore(settings),
        storage=SupabaseStorageClient(settings),
        auth=SupabaseAuthAdmin(settings),
    )
    run_account_deletion(
        ctx,
        batch_size=settings.retention_batch_size,
        armed=args.arm,
        guest_idle_days=args.guest_idle_days,
    )


if __name__ == "__main__":  # pragma: no cover
    main()
