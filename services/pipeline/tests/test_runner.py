from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import trimesh

from forms_pipeline.cad.dispatch import CadDispatcher
from forms_pipeline.config import Settings
from forms_pipeline.jobs import runner
from forms_pipeline.jobs.runner import (
    STEP_HANDLERS,
    Job,
    JobContext,
    PostgresJobStore,
    ScanInfo,
    ScanPathError,
    SupabaseStorageClient,
    handle_generating_cad,
    handle_measuring,
    owned_mesh_path,
    process_job,
    resolve_worker_steps,
    run_once,
)
from forms_pipeline.onshape.client import OnshapeRejectedError

ALL_STEPS = tuple(STEP_HANDLERS)


class FakeJobStore:
    """In-memory JobStore fake: no network, no real Postgres."""

    def __init__(self) -> None:
        self.jobs: list[Job] = []
        # scan_id -> mesh_path; owner is the path's first segment unless
        # overridden in scan_owners (to model a foreign mesh_path).
        self.scans: dict[str, str] = {}
        self.scan_owners: dict[str, str] = {}
        self.claim_steps: list[tuple[str, ...]] = []
        self.measurements: dict[tuple[str, str], dict[str, float]] = {}
        # (scan_id, extraction_version) -> (write sequence, validated, source).
        # The sequence stands in for created_at, refreshed on every upsert.
        self.measurement_meta: dict[tuple[str, str], tuple[int, bool, str]] = {}
        # Per-job CAD model descriptor dicts; a missing entry means None
        # (dispatcher falls back to the env default model).
        self.cad_models: dict[str, dict[str, Any] | None] = {}
        self.measurement_write_count = 0
        self.advanced: list[tuple[str, str, dict[str, Any] | None]] = []
        self.completed: list[tuple[str, str, dict[str, Any] | None]] = []
        self.failed: list[tuple[str, dict[str, Any], bool]] = []

    def claim_jobs(self, worker_id: str, steps: tuple[str, ...], limit: int = 1) -> list[Job]:
        # Mirrors claim_pipeline_job: only jobs whose step is in `steps`.
        self.claim_steps.append(steps)
        claimed = [job for job in self.jobs if job.step in steps][:limit]
        self.jobs = [job for job in self.jobs if job not in claimed]
        return claimed

    def get_scan(self, scan_id: str) -> ScanInfo:
        mesh_path = self.scans[scan_id]
        owner = self.scan_owners.get(scan_id, mesh_path.split("/")[0])
        return ScanInfo(storage_user_id=owner, capture_kind="mesh", mesh_path=mesh_path)

    def set_scan_mesh_path(self, scan_id: str, path: str) -> None:
        self.scans[scan_id] = path

    def upsert_measurements(
        self,
        scan_id: str,
        schema_version: str,
        extraction_version: str,
        values: dict[str, float],
        validated: bool,
        source: str,
    ) -> None:
        self.measurement_write_count += 1
        self.measurements[(scan_id, extraction_version)] = values
        self.measurement_meta[(scan_id, extraction_version)] = (
            self.measurement_write_count,
            validated,
            source,
        )

    def get_measurements(self, scan_id: str) -> dict[str, float]:
        # Mirrors the Postgres query: latest validated row for the scan.
        rows = [
            (seq, key)
            for key, (seq, validated, _source) in self.measurement_meta.items()
            if key[0] == scan_id and validated
        ]
        if not rows:
            raise LookupError(f"no validated measurements for scan {scan_id}")
        return self.measurements[max(rows)[1]]

    def get_cad_model(self, job: Job) -> dict[str, Any] | None:
        return self.cad_models.get(job.id)

    def advance(self, job_id: str, next_step: str, artifacts: dict[str, Any] | None = None) -> None:
        self.advanced.append((job_id, next_step, artifacts))

    def complete(self, job_id: str, step: str, artifacts: dict[str, Any] | None = None) -> None:
        self.completed.append((job_id, step, artifacts))

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


def _dry_run_cad() -> CadDispatcher:
    # Settings() has no Onshape credentials -> dry_run -> the default
    # descriptor uses the dry-run provider (canned STL, no network).
    return CadDispatcher(settings=Settings())


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
    ctx = JobContext(store=store, storage=storage, cad=_dry_run_cad())

    claimed = run_once("worker-1", ctx, ALL_STEPS, limit=2)

    assert claimed == 2
    # The bad job failed without raising out of the loop...
    assert len(store.failed) == 1
    assert store.failed[0][0] == "job-bad"
    # ...and the loop kept going: the good job was completed at 'measured' in
    # one call (never advanced to a pending 'measured' job no handler claims).
    assert [(job_id, step) for job_id, step, _ in store.completed] == [("job-good", "measured")]
    assert store.advanced == []


def test_gate_violation_fails_job_as_non_retriable(frustum_mesh: trimesh.Trimesh) -> None:
    # Scale the mesh up so extracted values blow past the schema's plausibility gates.
    huge_mesh = frustum_mesh.copy()
    huge_mesh.apply_scale(10.0)
    store = FakeJobStore()
    storage = FakeStorageClient(
        files={("meshes", "user-1/scan.obj"): _frustum_obj_bytes(huge_mesh)}
    )
    store.scans = {"scan-1": "user-1/scan.obj"}
    store.jobs = [_measuring_job("job-1", "scan-1")]
    ctx = JobContext(store=store, storage=storage, cad=_dry_run_cad())

    run_once("worker-1", ctx, ALL_STEPS, limit=1)

    assert len(store.failed) == 1
    job_id, error, retriable = store.failed[0]
    assert job_id == "job-1"
    assert retriable is False
    assert not store.completed


def test_measure_step_idempotent_rerun_does_not_duplicate(frustum_mesh: trimesh.Trimesh) -> None:
    store = FakeJobStore()
    storage = FakeStorageClient(
        files={("meshes", "user-1/scan.obj"): _frustum_obj_bytes(frustum_mesh)}
    )
    store.scans = {"scan-1": "user-1/scan.obj"}
    job = _measuring_job("job-1", "scan-1")
    ctx = JobContext(store=store, storage=storage, cad=_dry_run_cad())

    handle_measuring(job, ctx)
    handle_measuring(job, ctx)  # simulate a re-run after a crash before the job's status advanced

    assert store.measurement_write_count == 2
    # Same (scan_id, extraction_version) key both times -> one row, not two.
    assert len(store.measurements) == 1


def _cad_job(job_id: str, scan_id: str, order_id: str | None) -> Job:
    return Job(
        id=job_id,
        scan_id=scan_id,
        order_id=order_id,
        step="generating_cad",
        status="running",
        attempts=1,
        max_attempts=3,
    )


def _seed_measurements(store: FakeJobStore, scan_id: str) -> None:
    from forms_pipeline.contract import MEASUREMENT_KEYS
    from forms_pipeline.extraction.measure import EXTRACTION_VERSION

    store.upsert_measurements(
        scan_id, "1.0.0", EXTRACTION_VERSION, {key: 100.0 for key in MEASUREMENT_KEYS}, True, "scan"
    )


def test_generating_cad_with_per_product_descriptor_uploads_and_completes() -> None:
    store = FakeJobStore()
    storage = FakeStorageClient()
    _seed_measurements(store, "scan-1")
    job = _cad_job("job-1", "scan-1", order_id="order-1")
    store.cad_models["job-1"] = {
        "provider": "dry_run",
        "schema_version": "1.0.0",
        "ref": {},
        "variable_map": None,
    }
    ctx = JobContext(store=store, storage=storage, cad=_dry_run_cad())

    handle_generating_cad(job, ctx)

    assert ("stls", "scan-1/job-1.stl") in storage.uploaded
    # Phase 0: the CAD job ends at stl_ready (print steps are manual).
    [(job_id, step, artifacts)] = store.completed
    assert (job_id, step, artifacts["stl_path"]) == ("job-1", "stl_ready", "scan-1/job-1.stl")
    assert "cad" in artifacts
    assert store.advanced == []


def test_generating_cad_falls_back_to_default_descriptor() -> None:
    store = FakeJobStore()
    storage = FakeStorageClient()
    _seed_measurements(store, "scan-1")
    # No order and no cad_model registered -> get_cad_model returns None ->
    # dispatcher builds the env default descriptor (dry-run, no creds).
    job = _cad_job("job-1", "scan-1", order_id=None)
    ctx = JobContext(store=store, storage=storage, cad=_dry_run_cad())

    handle_generating_cad(job, ctx)

    assert ("stls", "scan-1/job-1.stl") in storage.uploaded
    assert store.completed[0][1] == "stl_ready"


def test_generating_cad_bad_descriptor_fails_non_retriable() -> None:
    store = FakeJobStore()
    storage = FakeStorageClient()
    _seed_measurements(store, "scan-1")
    job = _cad_job("job-1", "scan-1", order_id="order-1")
    # Unknown provider name: parses fine as a descriptor, but the registry
    # has no implementation -> ProviderNotFoundError -> non-retriable.
    store.cad_models["job-1"] = {
        "provider": "does-not-exist",
        "schema_version": "1.0.0",
        "ref": {},
        "variable_map": None,
    }
    store.jobs = [job]
    ctx = JobContext(store=store, storage=storage, cad=_dry_run_cad())

    run_once("worker-1", ctx, ALL_STEPS, limit=1)

    assert len(store.failed) == 1
    failed_job_id, _error, retriable = store.failed[0]
    assert failed_job_id == "job-1"
    assert retriable is False
    assert not store.completed


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


# ---------------------------------------------------------------------------
# Step-filtered claiming and WORKER_STEPS
# ---------------------------------------------------------------------------


def test_run_once_claims_only_the_given_steps(frustum_mesh: trimesh.Trimesh) -> None:
    store = FakeJobStore()
    storage = FakeStorageClient(
        files={("meshes", "user-1/scan.obj"): _frustum_obj_bytes(frustum_mesh)}
    )
    store.scans = {"scan-1": "user-1/scan.obj"}
    reconstruct_job = Job(
        id="job-r",
        scan_id="scan-2",
        order_id=None,
        step="reconstructing",
        status="pending",
        attempts=0,
        max_attempts=3,
    )
    store.jobs = [reconstruct_job, _measuring_job("job-m", "scan-1")]
    ctx = JobContext(store=store, storage=storage, cad=_dry_run_cad())

    claimed = run_once("worker-1", ctx, ("measuring",), limit=5)

    assert claimed == 1
    assert store.claim_steps == [("measuring",)]
    assert [job_id for job_id, _, _ in store.completed] == ["job-m"]
    # Never claimed, so never failed for lack of a handler.
    assert store.jobs == [reconstruct_job]
    assert store.failed == []


def test_resolve_worker_steps_defaults_to_registered_handlers() -> None:
    assert resolve_worker_steps(Settings()) == ALL_STEPS
    assert set(ALL_STEPS) >= {"measuring", "generating_cad"}


def test_resolve_worker_steps_narrows_to_worker_steps() -> None:
    assert resolve_worker_steps(Settings(worker_steps="measuring")) == ("measuring",)


def test_resolve_worker_steps_rejects_unregistered_step() -> None:
    # 'printing' is a real pipeline step with no handler in this build.
    with pytest.raises(ValueError, match="no registered handler"):
        resolve_worker_steps(Settings(worker_steps="measuring,printing"))


def test_settings_reject_unknown_worker_step() -> None:
    with pytest.raises(ValueError, match="unknown pipeline steps"):
        Settings(worker_steps="measurin")


def test_settings_parse_worker_steps_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKER_STEPS", " measuring , generating_cad ")
    assert Settings().worker_steps == ("measuring", "generating_cad")
    monkeypatch.setenv("WORKER_STEPS", "")
    assert Settings().worker_steps == ()


# ---------------------------------------------------------------------------
# mesh_path ownership (plan A1)
# ---------------------------------------------------------------------------


def test_owned_mesh_path_accepts_owner_prefix() -> None:
    assert owned_mesh_path("user-1", "user-1/scan-1.obj") == "user-1/scan-1.obj"


@pytest.mark.parametrize(
    "mesh_path",
    [
        "user-2/scan-1.obj",
        "user-1",
        "user-1/",
        "user-10/scan.obj",
        "user-1/../user-2/scan.obj",
        "user-1//scan.obj",
        "/user-1/scan.obj",
    ],
)
def test_owned_mesh_path_rejects_paths_outside_prefix(mesh_path: str) -> None:
    with pytest.raises(ScanPathError):
        owned_mesh_path("user-1", mesh_path)


def test_foreign_mesh_path_fails_job_non_retriably_without_download() -> None:
    store = FakeJobStore()
    storage = FakeStorageClient()  # any download would KeyError (retriable), not ScanPathError
    store.scans = {"scan-1": "user-2/their-scan.obj"}
    store.scan_owners = {"scan-1": "user-1"}
    store.jobs = [_measuring_job("job-1", "scan-1")]
    ctx = JobContext(store=store, storage=storage, cad=_dry_run_cad())

    run_once("worker-1", ctx, ALL_STEPS, limit=1)

    assert len(store.failed) == 1
    _job_id, error, retriable = store.failed[0]
    assert retriable is False
    assert "outside the owner's storage prefix" in error["reason"]
    assert store.completed == []


GUEST = "33333333-3333-4333-8333-333333333333"


def test_merged_scan_uses_storage_owner_not_current_owner() -> None:
    # After a guest merge scans.user_id is the member, but the objects stay
    # under the guest's prefix (storage_user_id).
    store = FakeJobStore()
    store.scans = {"scan-1": f"{GUEST}/scan-1.obj"}
    assert runner.get_scan_mesh_path(store, "scan-1") == f"{GUEST}/scan-1.obj"


def test_get_scan_selects_storage_user_id(fake_db) -> None:
    # scans.user_id (a merged member, or null after account deletion) is never
    # read; only storage_user_id decides the prefix.
    store = PostgresJobStore(Settings())
    db = fake_db(store, [(GUEST, "mesh", f"{GUEST}/scan-1.obj")])
    scan = store.get_scan("scan-1")
    sql = db.executed[0][0]
    assert sql.startswith("select storage_user_id,") and " user_id" not in sql
    assert scan == ScanInfo(GUEST, "mesh", f"{GUEST}/scan-1.obj")


def test_get_scan_null_storage_owner_raises_not_none_prefix(fake_db) -> None:
    store = PostgresJobStore(Settings())
    fake_db(store, [(None, "mesh", "None/scan-1.obj")])
    with pytest.raises(ScanPathError):
        store.get_scan("scan-1")


# ---------------------------------------------------------------------------
# SupabaseStorageClient.list
# ---------------------------------------------------------------------------


def _list_handler(tree: dict[str, list[dict[str, Any]]], calls: list[dict[str, Any]]):  # noqa: ANN202
    import json

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "POST"
        assert request.url.path == "/storage/v1/object/list/meshes"
        body = json.loads(request.content)
        calls.append(body)
        entries = tree.get(body["prefix"], [])
        return httpx.Response(200, json=entries[body["offset"] : body["offset"] + body["limit"]])

    return handler


def test_storage_list_pages_and_recurses_into_folders() -> None:
    files = [{"name": f"{i:03d}.jpg", "id": f"id-{i}"} for i in range(105)]
    tree = {
        "user-1/scan-1": [{"name": "capture.json", "id": "c"}, {"name": "images", "id": None}],
        "user-1/scan-1/images": files,
    }
    calls: list[dict[str, Any]] = []
    client = _storage_client_with_transport(_list_handler(tree, calls))

    paths = client.list("meshes", "user-1/scan-1/")

    assert sorted(paths) == sorted(
        ["user-1/scan-1/capture.json"] + [f"user-1/scan-1/images/{i:03d}.jpg" for i in range(105)]
    )
    assert [(c["prefix"], c["offset"]) for c in calls] == [
        ("user-1/scan-1", 0),
        ("user-1/scan-1/images", 0),
        ("user-1/scan-1/images", 100),
    ]


def test_storage_list_empty_prefix_returns_nothing() -> None:
    client = _storage_client_with_transport(_list_handler({}, []))
    assert client.list("meshes", "user-1/scan-1/") == []


def test_storage_list_raises_instead_of_truncating(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner, "STORAGE_LIST_MAX_PAGES", 2)
    tree = {"u/s": [{"name": f"{i:03d}.jpg", "id": str(i)} for i in range(250)]}
    client = _storage_client_with_transport(_list_handler(tree, []))

    with pytest.raises(RuntimeError, match="exceeded 2 pages"):
        client.list("meshes", "u/s/")


def test_storage_list_raises_on_http_error() -> None:
    client = _storage_client_with_transport(lambda request: httpx.Response(500))
    with pytest.raises(httpx.HTTPStatusError):
        client.list("meshes", "user-1/scan-1/")


def test_generating_cad_onshape_rejection_fails_non_retriable() -> None:
    store = FakeJobStore()
    storage = FakeStorageClient()
    _seed_measurements(store, "scan-1")
    job = _cad_job("job-1", "scan-1", order_id="order-1")

    class RejectingCad:
        def generate(self, *_args: Any) -> Any:
            raise OnshapeRejectedError("template is missing variables")

    ctx = JobContext(store=store, storage=storage, cad=RejectingCad())  # type: ignore[arg-type]

    process_job(job, ctx)

    [(failed_job_id, _error, retriable)] = store.failed
    assert failed_job_id == "job-1"
    assert retriable is False
    assert not storage.uploaded


def test_reconstructing_is_registered_and_quality_errors_dead_letter() -> None:
    from forms_pipeline.reconstruct import ReconstructionQualityError

    assert "reconstructing" in STEP_HANDLERS
    store = FakeJobStore()
    storage = FakeStorageClient()
    job = Job(
        id="job-r",
        order_id=None,
        scan_id="scan-1",
        step="reconstructing",
        status="running",
        attempts=1,
        max_attempts=3,
        artifacts={},
    )

    def boom(*_args: Any, **_kwargs: Any) -> None:
        raise ReconstructionQualityError("too few photos registered")

    original = STEP_HANDLERS["reconstructing"]
    STEP_HANDLERS["reconstructing"] = boom
    try:
        process_job(job, JobContext(store=store, storage=storage, cad=_dry_run_cad()))
    finally:
        STEP_HANDLERS["reconstructing"] = original

    [(_job_id, _error, retriable)] = store.failed
    assert retriable is False


# ---------------------------------------------------------------------------
# Manual measurements (submit_manual_measurements, 0014)
# ---------------------------------------------------------------------------


def _plausible_values() -> dict[str, float]:
    from forms_pipeline.contract import MEASUREMENT_KEYS, SCHEMA

    # Midpoint of every schema range, so the test never restates a range.
    return {
        key: (SCHEMA["properties"][key]["minimum"] + SCHEMA["properties"][key]["maximum"]) / 2
        for key in MEASUREMENT_KEYS
    }


def _manual_job(values: Any, job_id: str = "job-m") -> Job:
    return Job(
        id=job_id,
        scan_id="scan-1",
        order_id=None,
        step="measuring",
        status="running",
        attempts=1,
        max_attempts=3,
        artifacts={"source": "manual", "values": values},
    )


class NoDownloadStorage(FakeStorageClient):
    def download(self, bucket: str, path: str) -> bytes:
        raise AssertionError("a manual job must never touch the mesh")


def test_manual_measurements_happy_path_skips_mesh() -> None:
    store = FakeJobStore()  # no scan registered: get_scan would KeyError
    values = _plausible_values()
    # JSON integers arrive as int; the stored row is all floats.
    first_key = next(iter(values))
    values[first_key] = int(values[first_key])
    ctx = JobContext(store=store, storage=NoDownloadStorage(), cad=_dry_run_cad())

    process_job(_manual_job(values), ctx)

    assert store.failed == []
    assert store.completed == [("job-m", "measured", None)]
    row = store.measurements[("scan-1", runner.MANUAL_EXTRACTION_VERSION)]
    assert row == {key: float(v) for key, v in values.items()}
    assert all(type(v) is float for v in row.values())
    _seq, validated, source = store.measurement_meta[("scan-1", "manual-1")]
    assert (validated, source) == (True, "manual")


def _assert_manual_dead_letters(values: Any, reason_fragment: str) -> None:
    store = FakeJobStore()
    ctx = JobContext(store=store, storage=NoDownloadStorage(), cad=_dry_run_cad())

    process_job(_manual_job(values), ctx)

    [(job_id, error, retriable)] = store.failed
    assert job_id == "job-m"
    assert retriable is False
    assert reason_fragment in error["reason"]
    assert store.measurements == {}
    assert store.completed == []


def test_manual_measurements_missing_key_dead_letters() -> None:
    values = _plausible_values()
    dropped = next(iter(values))
    del values[dropped]
    _assert_manual_dead_letters(values, f"missing ['{dropped}']")


def test_manual_measurements_unknown_key_dead_letters() -> None:
    values = _plausible_values()
    values["S5_ISW"] = 100.0
    _assert_manual_dead_letters(values, "unknown ['S5_ISW']")


def test_manual_measurements_out_of_range_dead_letters() -> None:
    from forms_pipeline.contract import SCHEMA

    values = _plausible_values()
    key = next(iter(values))
    values[key] = SCHEMA["properties"][key]["maximum"] + 1
    _assert_manual_dead_letters(values, "outside plausible range")


@pytest.mark.parametrize("bad", ["120", True, None, [1.0]])
def test_manual_measurements_non_numeric_dead_letters(bad: Any) -> None:
    values: dict[str, Any] = _plausible_values()
    values[next(iter(values))] = bad
    _assert_manual_dead_letters(values, "expected a number")


def test_manual_measurements_non_object_dead_letters() -> None:
    _assert_manual_dead_letters([1.0, 2.0], "not an object")


def test_scan_path_writes_source_scan(frustum_mesh: trimesh.Trimesh) -> None:
    from forms_pipeline.extraction.measure import EXTRACTION_VERSION

    store = FakeJobStore()
    storage = FakeStorageClient(
        files={("meshes", "user-1/scan.obj"): _frustum_obj_bytes(frustum_mesh)}
    )
    store.scans = {"scan-1": "user-1/scan.obj"}

    handle_measuring(_measuring_job("job-1", "scan-1"), JobContext(store, storage, _dry_run_cad()))

    assert store.measurement_meta[("scan-1", EXTRACTION_VERSION)][1:] == (True, "scan")


class RecordingCad:
    def __init__(self) -> None:
        self.values: dict[str, float] | None = None

    def generate(self, job_id: str, values: dict[str, float], model: Any) -> Any:
        self.values = values
        return _dry_run_cad().generate(job_id, values, model)


def test_cad_uses_latest_validated_row_manual_over_scan() -> None:
    store = FakeJobStore()
    _seed_measurements(store, "scan-1")  # scan row, all 100.0
    manual = _plausible_values()
    process_job(_manual_job(manual), JobContext(store, NoDownloadStorage(), _dry_run_cad()))
    cad = RecordingCad()

    handle_generating_cad(
        _cad_job("job-c", "scan-1", order_id=None),
        JobContext(store, FakeStorageClient(), cad),  # type: ignore[arg-type]
    )

    assert cad.values == manual


def test_cad_ignores_unvalidated_and_rescan_after_manual_wins() -> None:
    from forms_pipeline.contract import MEASUREMENT_KEYS

    store = FakeJobStore()
    manual = _plausible_values()
    process_job(_manual_job(manual), JobContext(store, NoDownloadStorage(), _dry_run_cad()))
    store.upsert_measurements(
        "scan-1", "1.0.0", "x", {k: 1.0 for k in MEASUREMENT_KEYS}, False, "scan"
    )
    assert store.get_measurements("scan-1") == manual

    # A second adjustment re-upserts the same manual-1 key and becomes latest again.
    _seed_measurements(store, "scan-1")
    adjusted = {k: v + 1 for k, v in manual.items()}
    process_job(_manual_job(adjusted), JobContext(store, NoDownloadStorage(), _dry_run_cad()))
    assert store.get_measurements("scan-1") == adjusted


def test_postgres_get_measurements_selects_latest_validated(fake_db) -> None:
    store = PostgresJobStore(Settings())
    db = fake_db(store, [({"Leg_Length": 400.0},)])

    assert store.get_measurements("scan-1") == {"Leg_Length": 400.0}
    sql, params = db.executed[0]
    assert "validated = true" in sql and "order by created_at desc limit 1" in sql
    assert params == ("scan-1",)


def test_postgres_get_measurements_none_raises(fake_db) -> None:
    store = PostgresJobStore(Settings())
    fake_db(store, [])
    with pytest.raises(LookupError):
        store.get_measurements("scan-1")


def test_postgres_upsert_refreshes_created_at_and_writes_source(fake_db) -> None:
    store = PostgresJobStore(Settings())
    db = fake_db(store)

    store.upsert_measurements("scan-1", "1.0.0", "manual-1", {"Leg_Length": 400.0}, True, "manual")

    sql, params = db.executed[0]
    assert "created_at = now()" in sql and "source = excluded.source" in sql
    assert params[-1] == "manual"
