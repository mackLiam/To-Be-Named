from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import trimesh

from zells_pipeline.config import Settings
from zells_pipeline.jobs.runner import (
    Job,
    JobContext,
    SupabaseStorageClient,
    handle_measuring,
    run_once,
)
from zells_pipeline.onshape.client import OnshapeClient


class FakeJobStore:
    """In-memory JobStore fake: no network, no real Postgres."""

    def __init__(self) -> None:
        self.jobs: list[Job] = []
        self.scans: dict[str, str] = {}
        self.measurements: dict[tuple[str, str], dict[str, float]] = {}
        self.measurement_write_count = 0
        self.advanced: list[tuple[str, str, dict[str, Any] | None]] = []
        self.completed: list[tuple[str, dict[str, Any] | None]] = []
        self.failed: list[tuple[str, dict[str, Any], bool]] = []

    def claim_jobs(self, worker_id: str, limit: int = 1) -> list[Job]:
        claimed, self.jobs = self.jobs[:limit], self.jobs[limit:]
        return claimed

    def get_scan_mesh_path(self, scan_id: str) -> str:
        return self.scans[scan_id]

    def upsert_measurements(
        self,
        scan_id: str,
        schema_version: str,
        extraction_version: str,
        values: dict[str, float],
        validated: bool,
    ) -> None:
        self.measurements[(scan_id, extraction_version)] = values
        self.measurement_write_count += 1

    def get_measurements(self, scan_id: str, extraction_version: str) -> dict[str, float]:
        return self.measurements[(scan_id, extraction_version)]

    def advance(self, job_id: str, next_step: str, artifacts: dict[str, Any] | None = None) -> None:
        self.advanced.append((job_id, next_step, artifacts))

    def complete(self, job_id: str, artifacts: dict[str, Any] | None = None) -> None:
        self.completed.append((job_id, artifacts))

    def fail(self, job_id: str, error: dict[str, Any], retriable: bool = True) -> None:
        self.failed.append((job_id, error, retriable))


@dataclass
class FakeStorageClient:
    """In-memory StorageClient fake keyed by (bucket, path)."""

    files: dict[tuple[str, str], bytes] = field(default_factory=dict)
    uploaded: dict[tuple[str, str], bytes] = field(default_factory=dict)

    def download(self, bucket: str, path: str) -> bytes:
        return self.files[(bucket, path)]

    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None:
        self.uploaded[(bucket, path)] = data


def _dry_run_onshape() -> OnshapeClient:
    return OnshapeClient(settings=Settings())


def _frustum_obj_bytes(frustum_mesh: trimesh.Trimesh) -> bytes:
    return frustum_mesh.export(file_type="obj").encode("utf-8")


def _measuring_job(job_id: str, scan_id: str) -> Job:
    return Job(
        id=job_id,
        scan_id=scan_id,
        order_id=None,
        step="measuring",
        status="running",
        attempts=1,
        max_attempts=3,
    )


def test_failing_handler_marks_job_failed_and_loop_continues(
    frustum_mesh: trimesh.Trimesh,
) -> None:
    store = FakeJobStore()
    good_bytes = _frustum_obj_bytes(frustum_mesh)
    storage = FakeStorageClient(files={("meshes", "good/scan.obj"): good_bytes})
    # scan-bad has no mesh_path registered at all, so get_scan_mesh_path raises KeyError.
    store.scans = {"scan-good": "good/scan.obj"}
    store.jobs = [
        _measuring_job("job-bad", "scan-bad"),
        _measuring_job("job-good", "scan-good"),
    ]
    ctx = JobContext(store=store, storage=storage, onshape=_dry_run_onshape())

    claimed = run_once("worker-1", ctx, limit=2)

    assert claimed == 2
    # The bad job failed without raising out of the loop...
    assert len(store.failed) == 1
    assert store.failed[0][0] == "job-bad"
    # ...and the loop kept going: the good job still got processed and advanced.
    assert len(store.advanced) == 1
    assert store.advanced[0][0] == "job-good"
    assert store.advanced[0][1] == "measured"


def test_gate_violation_fails_job_as_non_retriable(frustum_mesh: trimesh.Trimesh) -> None:
    # Scale the mesh up so extracted values blow past the schema's plausibility gates.
    huge_mesh = frustum_mesh.copy()
    huge_mesh.apply_scale(10.0)
    store = FakeJobStore()
    storage = FakeStorageClient(files={("meshes", "scan.obj"): _frustum_obj_bytes(huge_mesh)})
    store.scans = {"scan-1": "scan.obj"}
    store.jobs = [_measuring_job("job-1", "scan-1")]
    ctx = JobContext(store=store, storage=storage, onshape=_dry_run_onshape())

    run_once("worker-1", ctx, limit=1)

    assert len(store.failed) == 1
    job_id, error, retriable = store.failed[0]
    assert job_id == "job-1"
    assert retriable is False
    assert not store.advanced


def test_measure_step_idempotent_rerun_does_not_duplicate(frustum_mesh: trimesh.Trimesh) -> None:
    store = FakeJobStore()
    storage = FakeStorageClient(files={("meshes", "scan.obj"): _frustum_obj_bytes(frustum_mesh)})
    store.scans = {"scan-1": "scan.obj"}
    job = _measuring_job("job-1", "scan-1")
    ctx = JobContext(store=store, storage=storage, onshape=_dry_run_onshape())

    handle_measuring(job, ctx)
    handle_measuring(job, ctx)  # simulate a re-run after a crash before the job's status advanced

    assert store.measurement_write_count == 2
    # Same (scan_id, extraction_version) key both times -> one row, not two.
    assert len(store.measurements) == 1


def _storage_client_with_transport(handler) -> SupabaseStorageClient:  # noqa: ANN001
    transport = httpx.MockTransport(handler)
    http_client = httpx.Client(
        transport=transport, base_url="https://example.supabase.co/storage/v1"
    )
    return SupabaseStorageClient(settings=Settings(), client=http_client)


def test_storage_delete_treats_404_as_success() -> None:
    """Used by the retention sweep (jobs/retention.py): an object already gone
    (e.g. a prior sweep run deleted it but crashed before marking the DB row)
    must not surface as an error on retry."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "DELETE"
        return httpx.Response(404)

    client = _storage_client_with_transport(handler)

    client.delete("meshes", "user-1/scan.obj")  # must not raise


def test_storage_delete_raises_on_real_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    client = _storage_client_with_transport(handler)

    with pytest.raises(httpx.HTTPStatusError):
        client.delete("meshes", "user-1/scan.obj")


def test_storage_delete_succeeds_on_200() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"message": "deleted"})

    client = _storage_client_with_transport(handler)

    client.delete("meshes", "user-1/scan.obj")  # must not raise
