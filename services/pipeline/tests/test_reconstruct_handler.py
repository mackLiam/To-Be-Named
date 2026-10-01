from __future__ import annotations

import io
import json
import stat
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest
import trimesh
from test_reconstruct_synthetic import (
    EXPECTED_LEG_LENGTH_MM,
    camera_ring,
    capture_bytes,
    capture_doc,
    fake_jpeg,
    make_leg_scene,
    similarity,
    to_photo_points,
    to_photo_poses,
    write_obj,
)

from forms_pipeline.config import Settings
from forms_pipeline.extraction.measure import extract_measurements
from forms_pipeline.extraction.mesh_loading import MeshValidationError
from forms_pipeline.jobs.runner import ScanInfo
from forms_pipeline.reconstruct import BundleValidationError, ReconstructionQualityError
from forms_pipeline.reconstruct.align import CAMERA_TO_WORLD, WORLD_TO_CAMERA
from forms_pipeline.reconstruct.handler import ReconstructCliError, handle_reconstructing
from forms_pipeline.reconstruct.segment import LEG_LENGTH_KEY

USER = "11111111-1111-4111-8111-111111111111"
SCAN = "22222222-2222-4222-8222-222222222222"
PREFIX = f"{USER}/{SCAN}/"


@dataclass(frozen=True)
class Job:
    id: str = "job-1"
    scan_id: str = SCAN
    step: str = "reconstructing"


@dataclass
class FakeStore:
    capture_kind: str = "photos"
    mesh_paths: dict[str, str] = field(default_factory=dict)
    advanced: list[tuple[str, str, dict[str, Any] | None]] = field(default_factory=list)

    def get_scan(self, scan_id: str) -> ScanInfo:
        # The runner's real row type, so a shape change there breaks this suite.
        return ScanInfo(user_id=USER, capture_kind=self.capture_kind, mesh_path=None)

    def set_scan_mesh_path(self, scan_id: str, path: str) -> None:
        self.mesh_paths[scan_id] = path

    def advance(self, job_id: str, next_step: str, artifacts: dict[str, Any] | None = None) -> None:
        self.advanced.append((job_id, next_step, artifacts))


@dataclass
class FakeStorage:
    files: dict[tuple[str, str], bytes] = field(default_factory=dict)
    downloads: list[tuple[str, str]] = field(default_factory=list)

    def download(self, bucket: str, path: str) -> bytes:
        self.downloads.append((bucket, path))
        return self.files[(bucket, path)]

    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None:
        self.files[(bucket, path)] = data


@dataclass
class Ctx:
    store: FakeStore
    storage: FakeStorage


def _fake_cli(tmp_path: Path, exit_code: int = 0, convention: str = CAMERA_TO_WORLD) -> Path:
    """A stand-in forms-reconstruct: copies a synthetic photogrammetry result into --out."""
    arkit = camera_ring()
    s, rot, t = similarity()
    src = tmp_path / "cli-src"
    src.mkdir(exist_ok=True)
    scene = make_leg_scene()
    scene.vertices = to_photo_points(scene.vertices, s, rot, t)
    (src / "model.obj").write_bytes(write_obj(scene))
    poses = to_photo_poses(arkit, s, rot, t, convention=convention, noise_m=0.002)
    (src / "poses.json").write_text(
        json.dumps({k: [float(v) for v in m.T.ravel()] for k, m in poses.items()})
    )
    script = tmp_path / "forms-reconstruct"
    script.write_text(
        "#!/bin/sh\n"
        f'echo "$@" > "{tmp_path}/argv"\n'
        f'ls "$2" > "{tmp_path}/images-seen"\n'
        f"if [ {exit_code} -ne 0 ]; then "
        f'echo \'{{"error":"session_error","reason":"/secret/path"}}\' >&2; exit {exit_code}; fi\n'
        f'cp "{src}"/* "$4"/\n'
    )
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    return script


def _setup(tmp_path: Path, **cli: Any) -> tuple[Ctx, Settings]:
    storage = FakeStorage()
    storage.files[("meshes", f"{PREFIX}capture.json")] = capture_bytes(capture_doc())
    for name in camera_ring():
        storage.files[("meshes", f"{PREFIX}images/{name}")] = fake_jpeg()
    settings = Settings(reconstruct_cli=_fake_cli(tmp_path, **cli), reconstruct_timeout_s=60)
    return Ctx(FakeStore(), storage), settings


@pytest.fixture
def private_tmp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(work))
    return work


@pytest.mark.parametrize("convention", [CAMERA_TO_WORLD, WORLD_TO_CAMERA])
def test_happy_path_uploads_measurable_mm_mesh(
    tmp_path: Path, private_tmp: Path, convention: str
) -> None:
    ctx, settings = _setup(tmp_path, convention=convention)

    handle_reconstructing(Job(), ctx, settings)

    mesh_path = f"{USER}/{SCAN}.obj"
    assert ctx.store.mesh_paths == {SCAN: mesh_path}
    (job_id, step, artifacts) = ctx.store.advanced[-1]
    assert (job_id, step) == ("job-1", "measuring")
    assert artifacts["registered"] == artifacts["total"] == 40
    assert artifacts["pose_convention"] == convention
    assert artifacts["ankle_found"] and artifacts["knee_found"]
    assert artifacts["residual_m"] < 0.02
    assert artifacts["scale"] == pytest.approx(similarity()[0], rel=0.02)
    json.dumps(artifacts)  # artifacts land in a jsonb column

    mesh = trimesh.load(
        io.BytesIO(ctx.storage.files[("meshes", mesh_path)]), file_type="obj", process=False
    )
    result = extract_measurements(mesh)
    assert result.needs_scale_confirmation is False
    assert result.values[LEG_LENGTH_KEY] == pytest.approx(EXPECTED_LEG_LENGTH_MM, abs=12)

    argv = (tmp_path / "argv").read_text().split()
    assert argv[4:] == ["--detail", "reduced", "--timeout-s", "60"]
    assert (tmp_path / "images-seen").read_text().split() == sorted(camera_ring())
    assert list(private_tmp.iterdir()) == []  # temp dir removed


def test_rerun_is_idempotent(tmp_path: Path, private_tmp: Path) -> None:
    ctx, settings = _setup(tmp_path)
    handle_reconstructing(Job(), ctx, settings)
    first = dict(ctx.storage.files)
    handle_reconstructing(Job(), ctx, settings)
    assert ctx.storage.files == first
    assert ctx.store.advanced[0] == ctx.store.advanced[1]


def test_storage_keys_are_derived_from_scan_row(tmp_path: Path, private_tmp: Path) -> None:
    ctx, settings = _setup(tmp_path)
    handle_reconstructing(Job(), ctx, settings)
    assert all(path.startswith(PREFIX) for _, path in ctx.storage.downloads)
    assert {b for b, _ in ctx.storage.downloads} == {"meshes"}


def test_non_photo_scan_is_non_retriable(tmp_path: Path, private_tmp: Path) -> None:
    ctx, settings = _setup(tmp_path)
    ctx.store.capture_kind = "lidar"
    with pytest.raises(BundleValidationError, match="not a photo capture"):
        handle_reconstructing(Job(), ctx, settings)
    assert ctx.storage.downloads == []


def test_path_traversal_name_never_reaches_storage(tmp_path: Path, private_tmp: Path) -> None:
    ctx, settings = _setup(tmp_path)
    doc = capture_doc()
    doc["images"][5]["file"] = "../../other-user/000.jpg"
    ctx.storage.files[("meshes", f"{PREFIX}capture.json")] = capture_bytes(doc)
    with pytest.raises(BundleValidationError):
        handle_reconstructing(Job(), ctx, settings)
    assert ctx.storage.downloads == [("meshes", f"{PREFIX}capture.json")]


def test_oversize_jpeg_fails_before_cli(tmp_path: Path, private_tmp: Path) -> None:
    ctx, settings = _setup(tmp_path)
    ctx.storage.files[("meshes", f"{PREFIX}images/007.jpg")] = fake_jpeg() + b"\0" * (3 << 20)
    with pytest.raises(BundleValidationError, match="007.jpg is larger"):
        handle_reconstructing(Job(), ctx, settings)
    assert not (tmp_path / "argv").exists()
    assert list(private_tmp.iterdir()) == []


@pytest.mark.parametrize("code", [2, 3])
def test_cli_input_and_reconstruction_failures_are_rescan(
    tmp_path: Path, private_tmp: Path, code: int
) -> None:
    ctx, settings = _setup(tmp_path, exit_code=code)
    with pytest.raises(ReconstructionQualityError, match=r"\(session_error\)") as exc:
        handle_reconstructing(Job(), ctx, settings)
    assert "/secret/path" not in str(exc.value)
    assert ctx.store.advanced == []
    assert list(private_tmp.iterdir()) == []


@pytest.mark.parametrize("code", [4, 1, 5])
def test_cli_timeout_and_crashes_are_retriable(
    tmp_path: Path, private_tmp: Path, code: int
) -> None:
    ctx, settings = _setup(tmp_path, exit_code=code)
    with pytest.raises(ReconstructCliError, match=f"exit code {code}"):
        handle_reconstructing(Job(), ctx, settings)
    assert not issubclass(ReconstructCliError, ReconstructionQualityError | BundleValidationError)


def test_missing_cli_is_retriable(tmp_path: Path, private_tmp: Path) -> None:
    ctx, settings = _setup(tmp_path)
    settings = settings.model_copy(update={"reconstruct_cli": tmp_path / "nope"})
    with pytest.raises(ReconstructCliError, match="could not be started"):
        handle_reconstructing(Job(), ctx, settings)


def test_hung_cli_is_killed_and_retriable(tmp_path: Path, private_tmp: Path, monkeypatch) -> None:
    from forms_pipeline.reconstruct import handler

    ctx, settings = _setup(tmp_path)
    hang = tmp_path / "hang"
    hang.write_text("#!/bin/sh\nsleep 30\n")
    hang.chmod(0o755)
    monkeypatch.setattr(handler, "SUBPROCESS_GRACE_S", 0)
    settings = settings.model_copy(update={"reconstruct_cli": hang, "reconstruct_timeout_s": 1})
    with pytest.raises(ReconstructCliError, match="timed out"):
        handle_reconstructing(Job(), ctx, settings)


def test_output_over_mesh_cap_is_rejected(
    tmp_path: Path, private_tmp: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from forms_pipeline.reconstruct import handler

    ctx, settings = _setup(tmp_path)
    settings = settings.model_copy(update={"max_mesh_mb": 1})
    real = handler.export_obj_mm
    monkeypatch.setattr(handler, "export_obj_mm", lambda mesh: real(mesh) + b"#" * (2 << 20))
    with pytest.raises(MeshValidationError, match="exceeds"):
        handle_reconstructing(Job(), ctx, settings)
    assert ctx.store.mesh_paths == {}


def test_malformed_poses_are_retriable(tmp_path: Path, private_tmp: Path) -> None:
    ctx, settings = _setup(tmp_path)
    (tmp_path / "cli-src" / "poses.json").write_text(json.dumps({"../x": [0] * 16}))
    with pytest.raises(ReconstructCliError, match="malformed"):
        handle_reconstructing(Job(), ctx, settings)
