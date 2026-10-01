"""Worker loop: claim a pipeline job, dispatch it to a step handler, advance or fail it.

Fail-the-job-never-the-worker (docs/DESIGN.md gotcha #6): every handler
invocation is wrapped so that any exception marks the *job* failed via
`fail_pipeline_job` and the worker process keeps polling for the next job.
A bug in one job's mesh, or a flaky Onshape call, must never take down the
worker for every other job in the queue.

Handlers are idempotent, keyed by `job_id`/`scan_id`:
- The measure step upserts the measurements row on `(scan_id,
  extraction_version)`, matching the unique constraint in
  `supabase/migrations/0001_schema.sql`, so re-running it after a crash
  overwrites rather than duplicates.
- The CAD step writes the STL to a path derived from `scan_id`/`job_id` and
  uploads with upsert semantics, so re-running it overwrites the same
  object rather than accumulating orphaned files.

Storage and database access are both behind small interfaces
(`JobStore`, `StorageClient`) precisely so tests can fake them: no network,
no real Postgres in this module's test suite.
"""

from __future__ import annotations

import logging
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, NamedTuple, Protocol

import httpx

from forms_pipeline.cad.dispatch import CadDispatcher
from forms_pipeline.cad.model import DescriptorError
from forms_pipeline.cad.providers import ProviderNotFoundError
from forms_pipeline.config import Settings, get_settings
from forms_pipeline.contract import SCHEMA_VERSION, validate_measurements
from forms_pipeline.extraction.measure import EXTRACTION_VERSION, extract_measurements
from forms_pipeline.extraction.mesh_loading import MeshValidationError, load_mesh
from forms_pipeline.jobs.states import guard_transition
from forms_pipeline.onshape.client import OnshapeRejectedError

logger = logging.getLogger(__name__)

DEFAULT_POLL_INTERVAL_SECONDS = 5.0

# Storage list paging. A photo bundle is capped at 120 images + capture.json
# (plan A2), so 20 pages of 100 is far above any legitimate scan prefix; going
# past it raises instead of returning a truncated listing, because retention
# would then mark a scan deleted with objects left behind.
STORAGE_LIST_PAGE_SIZE = 100
STORAGE_LIST_MAX_PAGES = 20


class GateViolationError(RuntimeError):
    """Raised when extracted measurements fail the plausibility gates.

    Not retriable: the mesh parsed fine, but the resulting measurements are
    outside human-plausible ranges (docs/DESIGN.md gotcha #7). Retrying the
    same mesh would produce the same result, so the job should fail
    immediately with a user-facing "please rescan" reason.
    """


class ScanPathError(ValueError):
    """Raised when a scan's mesh_path is outside its owner's storage prefix.

    Not retriable: scans.mesh_path is client-writable ("scans: update own"
    RLS), so a path outside `${user_id}/` would make the service-role worker
    read (or retention delete) another user's object (plan A1).
    """


class ScanInfo(NamedTuple):
    user_id: str
    capture_kind: str
    mesh_path: str | None


def owned_mesh_path(user_id: str, mesh_path: str) -> str:
    """Return mesh_path if it is an object inside `${user_id}/`, else raise.

    Dot and empty segments are rejected too: the storage URL is built from the
    path, and an HTTP client normalizes `..`, which would escape the prefix.
    """
    segments = mesh_path.split("/")
    if (
        not user_id
        or segments[0] != user_id
        or len(segments) < 2
        or any(seg in ("", ".", "..") for seg in segments)
    ):
        raise ScanPathError("scan mesh_path is outside the owner's storage prefix")
    return mesh_path


@dataclass(frozen=True)
class Job:
    id: str
    scan_id: str
    order_id: str | None
    step: str
    status: str
    attempts: int
    max_attempts: int
    # The template a CAD job renders (set when a paid order enqueues CAD); None for measure jobs.
    product_id: str | None = None
    artifacts: dict[str, Any] = field(default_factory=dict)


class JobStore(Protocol):
    """Database access needed by the worker loop. Implemented for real by
    `PostgresJobStore`; faked in tests."""

    def claim_jobs(self, worker_id: str, steps: tuple[str, ...], limit: int = 1) -> list[Job]: ...
    def get_scan(self, scan_id: str) -> ScanInfo: ...
    def upsert_measurements(
        self,
        scan_id: str,
        schema_version: str,
        extraction_version: str,
        values: dict[str, float],
        validated: bool,
    ) -> None: ...
    def get_measurements(self, scan_id: str, extraction_version: str) -> dict[str, float]: ...
    def get_cad_model(self, job: Job) -> dict[str, Any] | None: ...
    def advance(
        self, job_id: str, next_step: str, artifacts: dict[str, Any] | None = None
    ) -> None: ...
    def complete(self, job_id: str, step: str, artifacts: dict[str, Any] | None = None) -> None: ...
    def fail(self, job_id: str, error: dict[str, Any], retriable: bool = True) -> None: ...


class StorageClient(Protocol):
    """Supabase Storage access needed by the worker loop and the retention sweep
    (jobs/retention.py)."""

    def download(self, bucket: str, path: str) -> bytes: ...
    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None: ...
    def delete(self, bucket: str, path: str) -> None: ...
    def list(self, bucket: str, prefix: str) -> list[str]: ...


@dataclass
class JobContext:
    store: JobStore
    storage: StorageClient
    cad: CadDispatcher


def get_scan_mesh_path(store: JobStore, scan_id: str) -> str:
    """The scan's mesh_path, validated to lie inside its owner's prefix (A1)."""
    scan = store.get_scan(scan_id)
    if scan.mesh_path is None:
        raise LookupError(f"scan {scan_id} has no mesh_path")
    return owned_mesh_path(scan.user_id, scan.mesh_path)


def handle_measuring(job: Job, ctx: JobContext) -> None:
    """Measure step: download the mesh, extract + gate measurements, complete the job.

    A measure job ends here (completed at 'measured' in one call); CAD is a
    separate job started when an order is paid (docs/DESIGN.md section 6).

    Idempotent: `upsert_measurements` writes onto the `(scan_id,
    extraction_version)` unique key, so re-running this handler for the
    same job after a crash overwrites the prior (possibly partial) result
    rather than creating a duplicate row.
    """
    mesh_path = get_scan_mesh_path(ctx.store, job.scan_id)
    data = ctx.storage.download("meshes", mesh_path)

    suffix = Path(mesh_path).suffix or ".obj"
    with tempfile.NamedTemporaryFile(suffix=suffix) as tmp:
        tmp.write(data)
        tmp.flush()
        mesh = load_mesh(tmp.name)
        result = extract_measurements(mesh)

    violations = validate_measurements(result.values)
    if violations:
        raise GateViolationError(
            "Measurements outside plausible range, please rescan: " + "; ".join(violations)
        )

    ctx.store.upsert_measurements(
        scan_id=job.scan_id,
        schema_version=SCHEMA_VERSION,
        extraction_version=EXTRACTION_VERSION,
        values=result.values,
        validated=True,
    )
    guard_transition(job.step, "measured")
    ctx.store.complete(
        job.id,
        "measured",
        artifacts={"needs_scale_confirmation": result.needs_scale_confirmation},
    )


def handle_generating_cad(job: Job, ctx: JobContext) -> None:
    """CAD step: resolve the product's CAD model, generate STL, upload it, complete.

    The CAD model descriptor comes from the job's product (paid order),
    else the ordered product; with neither, or no descriptor, the dispatcher
    falls back to the env-configured default model. In Phase 0 the CAD job
    ends at 'stl_ready'; print steps are manual.
    A malformed descriptor or unknown provider fails the job non-retriably
    (see _NON_RETRIABLE_ERRORS) rather than looping.

    Idempotent: the STL is uploaded with upsert semantics to a path derived
    from `scan_id`/`job_id`, so a re-run overwrites the same object.
    """
    values = ctx.store.get_measurements(job.scan_id, EXTRACTION_VERSION)
    cad_model = ctx.store.get_cad_model(job)

    result = ctx.cad.generate(job.id, values, cad_model)

    stl_path = f"{job.scan_id}/{job.id}.stl"
    ctx.storage.upload("stls", stl_path, result.stl_bytes, content_type="model/stl")

    guard_transition(job.step, "stl_ready")
    ctx.store.complete(
        job.id, "stl_ready", artifacts={"stl_path": stl_path, "cad": result.artifacts}
    )


STEP_HANDLERS: dict[str, Any] = {
    "measuring": handle_measuring,
    "generating_cad": handle_generating_cad,
}

# Failures that mean "this exact input will never succeed" -- not worth
# retrying with backoff, unlike a flaky network call.
_NON_RETRIABLE_ERRORS: tuple[type[Exception], ...] = (
    MeshValidationError,
    GateViolationError,
    ScanPathError,
    # A bad CAD model descriptor or an unknown provider name will never
    # succeed on retry: fail the job for admin triage, don't loop.
    DescriptorError,
    ProviderNotFoundError,
    # Onshape 4xx, a template missing variables, or values that break
    # regeneration: the same input fails the same way every time.
    OnshapeRejectedError,
)


def process_job(job: Job, ctx: JobContext) -> None:
    """Dispatch one claimed job to its step handler; never lets an exception escape."""
    handler = STEP_HANDLERS.get(job.step)
    if handler is None:
        logger.error("job %s: no handler registered for step %r", job.id, job.step)
        ctx.store.fail(
            job.id,
            {"step": job.step, "reason": f"no handler for step {job.step!r}"},
            retriable=False,
        )
        return

    try:
        handler(job, ctx)
    except Exception as exc:  # noqa: BLE001 - intentional: fail-the-job-never-the-worker
        logger.exception("job %s failed at step %s", job.id, job.step)
        retriable = not isinstance(exc, _NON_RETRIABLE_ERRORS)
        ctx.store.fail(job.id, {"step": job.step, "reason": str(exc)}, retriable=retriable)


def resolve_worker_steps(settings: Settings) -> tuple[str, ...]:
    """Steps this worker claims: STEP_HANDLERS keys, narrowed by WORKER_STEPS.

    A configured step without a registered handler is a startup error, not a
    silent no-op: the operator asked for work this build cannot do.
    """
    if not settings.worker_steps:
        return tuple(STEP_HANDLERS)
    unregistered = [step for step in settings.worker_steps if step not in STEP_HANDLERS]
    if unregistered:
        raise ValueError(f"WORKER_STEPS names steps with no registered handler: {unregistered}")
    return settings.worker_steps


def run_once(worker_id: str, ctx: JobContext, steps: tuple[str, ...], limit: int = 1) -> int:
    """Claim up to `limit` due jobs at `steps` and process each. Returns the number claimed."""
    jobs = ctx.store.claim_jobs(worker_id, steps, limit=limit)
    for job in jobs:
        process_job(job, ctx)
    return len(jobs)


def run_forever(
    worker_id: str,
    ctx: JobContext,
    poll_interval: float = DEFAULT_POLL_INTERVAL_SECONDS,
    steps: tuple[str, ...] | None = None,
) -> None:  # pragma: no cover - infinite loop; run_once is exercised directly in tests
    """Poll the queue forever, sleeping between empty polls."""
    if steps is None:
        steps = resolve_worker_steps(get_settings())
    logger.info("worker %s claiming steps %s", worker_id, ",".join(steps))
    while True:
        claimed = run_once(worker_id, ctx, steps, limit=1)
        if claimed == 0:
            time.sleep(poll_interval)


# ---------------------------------------------------------------------------
# Production implementations of JobStore / StorageClient.
# ---------------------------------------------------------------------------


class PostgresJobStore:
    """JobStore backed by the queue helper functions in
    supabase/migrations/0001_schema.sql. Every query is parameterized;
    no string-built SQL, ever (docs/DESIGN.md section 9 / Engineering
    standards: no injection).
    """

    def __init__(self, settings: Settings | None = None):
        import psycopg  # local import: keeps psycopg optional for pure-unit tests

        self._psycopg = psycopg
        self._settings = settings or get_settings()

    def _connect(self):  # noqa: ANN202 - psycopg.Connection typing needs the optional import
        return self._psycopg.connect(self._settings.database_url.get_secret_value())

    def claim_jobs(self, worker_id: str, steps: tuple[str, ...], limit: int = 1) -> list[Job]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "select id, order_id, scan_id, step, status, attempts, max_attempts, artifacts, "
                "product_id from claim_pipeline_job(%s, %s, %s)",
                (worker_id, list(steps), limit),
            )
            rows = cur.fetchall()
        return [
            Job(
                id=str(r[0]),
                order_id=str(r[1]) if r[1] is not None else None,
                scan_id=str(r[2]),
                step=r[3],
                status=r[4],
                attempts=r[5],
                max_attempts=r[6],
                artifacts=r[7] or {},
                product_id=str(r[8]) if r[8] is not None else None,
            )
            for r in rows
        ]

    def get_scan(self, scan_id: str) -> ScanInfo:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "select user_id, capture_kind, mesh_path from public.scans where id = %s",
                (scan_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise LookupError(f"scan {scan_id} not found")
        return ScanInfo(user_id=str(row[0]), capture_kind=row[1], mesh_path=row[2])

    def upsert_measurements(
        self,
        scan_id: str,
        schema_version: str,
        extraction_version: str,
        values: dict[str, float],
        validated: bool,
    ) -> None:
        import json

        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                insert into public.measurements
                    (scan_id, schema_version, extraction_version, "values", validated)
                values (%s, %s, %s, %s, %s)
                on conflict (scan_id, extraction_version)
                do update set "values" = excluded."values", validated = excluded.validated
                """,
                (scan_id, schema_version, extraction_version, json.dumps(values), validated),
            )
            conn.commit()

    def get_measurements(self, scan_id: str, extraction_version: str) -> dict[str, float]:
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                'select "values" from public.measurements '
                "where scan_id = %s and extraction_version = %s",
                (scan_id, extraction_version),
            )
            row = cur.fetchone()
        if row is None:
            raise LookupError(f"no measurements for scan {scan_id} at version {extraction_version}")
        return dict(row[0])

    def get_cad_model(self, job: Job) -> dict[str, Any] | None:
        """Resolve the CAD model descriptor for a job via
        coalesce(job.product_id, order.product_id) -> product.cad_model (A7).

        Returns None when neither names a product or the product has no
        cad_model; the dispatcher then falls back to the env default model.
        """
        if job.product_id is None and job.order_id is None:
            return None
        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "select p.cad_model "
                "from public.pipeline_jobs j "
                "left join public.orders o on o.id = j.order_id "
                "join public.products p on p.id = coalesce(j.product_id, o.product_id) "
                "where j.id = %s",
                (job.id,),
            )
            row = cur.fetchone()
        if row is None or row[0] is None:
            return None
        return dict(row[0])

    def advance(self, job_id: str, next_step: str, artifacts: dict[str, Any] | None = None) -> None:
        import json

        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "select advance_pipeline_job(%s, %s, %s)",
                (job_id, next_step, json.dumps(artifacts) if artifacts else None),
            )
            conn.commit()

    def complete(self, job_id: str, step: str, artifacts: dict[str, Any] | None = None) -> None:
        import json

        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "select complete_pipeline_job(%s, %s, %s)",
                (job_id, step, json.dumps(artifacts) if artifacts else None),
            )
            conn.commit()

    def fail(self, job_id: str, error: dict[str, Any], retriable: bool = True) -> None:
        import json

        with self._connect() as conn, conn.cursor() as cur:
            cur.execute(
                "select fail_pipeline_job(%s, %s, %s)",
                (job_id, json.dumps(error), retriable),
            )
            conn.commit()


class SupabaseStorageClient:
    """StorageClient backed by the Supabase Storage REST API.

    Uses the service role key exclusively (never the anon key), sent only
    in request headers -- never logged, never included in exception
    messages below.
    """

    def __init__(self, settings: Settings | None = None, client: httpx.Client | None = None):
        self._settings = settings or get_settings()
        key = self._settings.supabase_service_role_key.get_secret_value()
        self._client = client or httpx.Client(
            base_url=f"{self._settings.supabase_url}/storage/v1",
            timeout=60.0,
            headers={"Authorization": f"Bearer {key}", "apikey": key},
        )

    def close(self) -> None:
        self._client.close()

    def download(self, bucket: str, path: str) -> bytes:
        response = self._client.get(f"/object/{bucket}/{path}")
        response.raise_for_status()
        return response.content

    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None:
        response = self._client.post(
            f"/object/{bucket}/{path}",
            content=data,
            headers={"Content-Type": content_type, "x-upsert": "true"},
        )
        response.raise_for_status()

    def delete(self, bucket: str, path: str) -> None:
        """Delete one object. Idempotent: a 404 (already gone) is treated as
        success, not an error, so the retention sweep can safely retry a
        partially-completed deletion (storage removed, DB mark not yet
        committed) without failing the item."""
        response = self._client.delete(f"/object/{bucket}/{path}")
        if response.status_code == 404:
            return
        response.raise_for_status()

    def list(self, bucket: str, prefix: str) -> list[str]:
        """Every object path under `prefix` (recursing into folders), paged.

        Supabase's list endpoint is one folder level per call and returns
        folders as entries with a null id. Raises past STORAGE_LIST_MAX_PAGES
        rather than returning a partial listing.
        """
        paths: list[str] = []
        folders = [prefix.strip("/")]
        pages = 0
        while folders:
            folder = folders.pop()
            offset = 0
            while True:
                pages += 1
                if pages > STORAGE_LIST_MAX_PAGES:
                    raise RuntimeError(
                        f"storage list exceeded {STORAGE_LIST_MAX_PAGES} pages in bucket {bucket}"
                    )
                response = self._client.post(
                    f"/object/list/{bucket}",
                    json={
                        "prefix": folder,
                        "limit": STORAGE_LIST_PAGE_SIZE,
                        "offset": offset,
                        "sortBy": {"column": "name", "order": "asc"},
                    },
                )
                response.raise_for_status()
                entries = response.json()
                for entry in entries:
                    child = f"{folder}/{entry['name']}" if folder else entry["name"]
                    if entry.get("id") is None:
                        folders.append(child)
                    else:
                        paths.append(child)
                if len(entries) < STORAGE_LIST_PAGE_SIZE:
                    break
                offset += STORAGE_LIST_PAGE_SIZE
        return paths
