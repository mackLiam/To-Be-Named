"""Reconstructing step: photo bundle in storage -> metric ankle-to-knee OBJ (mm).

Capture v1 (photogrammetry) runs only on a macOS worker with the forms-reconstruct
CLI built (services/reconstruct). Capture v2 (silhouette) is pure Python and runs on
any worker. Storage keys are derived from the scan row's storage_user_id
and scan_id, never from client input (A1), and every write is an upsert to a key
derived from them, so re-running a job lands in the same state.
"""

from __future__ import annotations

import json
import logging
import math
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, Protocol

import numpy as np
import trimesh

from forms_pipeline.config import Settings, get_settings
from forms_pipeline.extraction.mesh_loading import MeshValidationError, load_mesh
from forms_pipeline.jobs.states import guard_transition
from forms_pipeline.reconstruct import BundleValidationError, ReconstructionQualityError
from forms_pipeline.reconstruct.align import align_poses
from forms_pipeline.reconstruct.bundle import (
    FILE_NAME_RE,
    METHOD_SILHOUETTE,
    CaptureBundle,
    matrix_from_column_major,
    parse_capture,
    validate_jpeg,
    validate_mask,
)
from forms_pipeline.reconstruct.segment import meters_to_mm, segment_leg
from forms_pipeline.reconstruct.silhouette import View, reconstruct_silhouette

logger = logging.getLogger(__name__)

BUCKET = "meshes"
NEXT_STEP = "measuring"
PHOTO_CAPTURE_KIND = "photos"
# Only cameras ARKit reported as fully tracked anchor the metric alignment.
TRUSTED_TRACKING = "normal"
# Backstop over the CLI's own --timeout-s so a wedged process cannot hold the job.
SUBPROCESS_GRACE_S = 60

EXIT_BAD_INPUT = 2
EXIT_RECONSTRUCTION_FAILED = 3


class ReconstructCliError(RuntimeError):
    """The CLI timed out, crashed or is missing. Presumed transient: retried."""


class ScanRow(Protocol):
    """The scan fields this step reads; jobs.runner.ScanInfo satisfies it."""

    @property
    def storage_user_id(self) -> str: ...
    @property
    def capture_kind(self) -> str: ...


class ScanStore(Protocol):
    def get_scan(self, scan_id: str) -> ScanRow: ...

    def set_scan_mesh_path(self, scan_id: str, path: str) -> None: ...
    def advance(
        self, job_id: str, next_step: str, artifacts: dict[str, Any] | None = None
    ) -> None: ...


class Storage(Protocol):
    def download(self, bucket: str, path: str) -> bytes: ...
    def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None: ...


class ReconstructJob(Protocol):
    id: str
    scan_id: str
    step: str


class ReconstructContext(Protocol):
    store: ScanStore
    storage: Storage


def _uuid(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError) as exc:
        raise BundleValidationError("Scan record is malformed.") from exc


def run_cli(images_dir: Path, out_dir: Path, settings: Settings) -> None:
    """Run forms-reconstruct and type its failure by exit code."""
    cmd = [
        str(settings.reconstruct_cli),
        "--images",
        str(images_dir),
        "--out",
        str(out_dir),
        "--detail",
        settings.reconstruct_detail,
        "--timeout-s",
        str(settings.reconstruct_timeout_s),
    ]
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell, paths we created
            cmd,
            capture_output=True,
            timeout=settings.reconstruct_timeout_s + SUBPROCESS_GRACE_S,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ReconstructCliError("Reconstruction timed out.") from exc
    except OSError as exc:
        raise ReconstructCliError("Reconstruction tool could not be started.") from exc

    if proc.returncode == 0:
        return
    kind = _error_kind(proc.stderr)
    if proc.returncode in (EXIT_BAD_INPUT, EXIT_RECONSTRUCTION_FAILED):
        raise ReconstructionQualityError(
            f"The photos could not be turned into a 3D model ({kind}). Please rescan, "
            "moving slowly all the way around the leg in good light."
        )
    raise ReconstructCliError(f"Reconstruction failed with exit code {proc.returncode} ({kind}).")


def _error_kind(stderr: bytes) -> str:
    """The CLI's machine-readable error kind only; its free-text reason is not echoed."""
    try:
        line = stderr.decode("utf-8", "replace").strip().splitlines()[-1]
        kind = json.loads(line).get("error", "unknown")
    except (IndexError, ValueError, AttributeError):
        return "unknown"
    return kind if isinstance(kind, str) and kind.isidentifier() and len(kind) <= 32 else "unknown"


def read_poses(path: Path) -> dict[str, np.ndarray]:
    try:
        raw = json.loads(path.read_bytes())
    except (OSError, ValueError) as exc:
        raise ReconstructCliError("Reconstruction produced no camera poses.") from exc
    if not isinstance(raw, dict):
        raise ReconstructCliError("Reconstruction produced malformed camera poses.")
    poses: dict[str, np.ndarray] = {}
    for name, values in raw.items():
        if (
            not FILE_NAME_RE.fullmatch(name)
            or not isinstance(values, list)
            or len(values) != 16
            or not all(isinstance(v, int | float) and math.isfinite(v) for v in values)
        ):
            raise ReconstructCliError("Reconstruction produced malformed camera poses.")
        poses[name] = matrix_from_column_major(values)
    return poses


def export_obj_mm(mesh_m: trimesh.Trimesh) -> bytes:
    mesh_mm = trimesh.Trimesh(
        vertices=meters_to_mm(np.asarray(mesh_m.vertices)), faces=mesh_m.faces, process=False
    )
    text = trimesh.exchange.obj.export_obj(
        mesh_mm, include_normals=False, include_color=False, include_texture=False
    )
    return text.encode("utf-8")


def handle_reconstructing(
    job: ReconstructJob, ctx: ReconstructContext, settings: Settings | None = None
) -> None:
    settings = settings or get_settings()
    scan = ctx.store.get_scan(job.scan_id)
    if scan.capture_kind != PHOTO_CAPTURE_KIND:
        raise BundleValidationError("This scan is not a photo capture and cannot be reconstructed.")
    owner, scan_id = _uuid(scan.storage_user_id), _uuid(job.scan_id)
    prefix = f"{owner}/{scan_id}/"

    bundle = parse_capture(ctx.storage.download(BUCKET, f"{prefix}capture.json"))
    if bundle.method == METHOD_SILHOUETTE:
        _handle_silhouette(job, ctx, settings, bundle, owner, scan_id)
        return

    with tempfile.TemporaryDirectory(prefix="forms-reconstruct-") as tmp:
        images_dir = Path(tmp) / "images"
        out_dir = Path(tmp) / "out"
        images_dir.mkdir()
        out_dir.mkdir()
        for image in bundle.images:
            # parse_capture already pinned image.file to ^\d{3}\.jpg$.
            data = ctx.storage.download(BUCKET, f"{prefix}images/{image.file}")
            validate_jpeg(image, data)
            (images_dir / image.file).write_bytes(data)

        run_cli(images_dir, out_dir, settings)
        photo_poses = read_poses(out_dir / "poses.json")
        model = load_mesh(out_dir / "model.obj", settings)

    trusted = {
        img.file: img.camera_to_world for img in bundle.images if img.tracking == TRUSTED_TRACKING
    }
    alignment = align_poses(photo_poses, trusted, total_uploaded=len(bundle.images))
    aligned = trimesh.Trimesh(
        vertices=alignment.apply(np.asarray(model.vertices)), faces=model.faces, process=False
    )
    cameras = np.array([img.camera_to_world[:3, 3] for img in bundle.images])
    # alignment.apply maps photogrammetry INTO ARKit world, the frame anchor_world is
    # already in (capture contract), so the anchor needs no transform here.
    capture = bundle.capture
    anchor = np.array(capture.anchor_world) if capture is not None else None
    segment = segment_leg(aligned, cameras, anchor_world=anchor)

    artifacts = {
        "registered": len(photo_poses),
        "total": len(bundle.images),
        "scale": alignment.scale,
        "residual_m": alignment.residual_m,
        "pose_convention": alignment.convention,
        "ankle_found": segment.confidence["ankle_found"],
        "knee_found": segment.confidence["knee_found"],
        "mode": capture.mode if capture is not None else None,
        "finished_early": capture.finished_early if capture is not None else None,
        "coverage": capture.coverage if capture is not None else None,
        "axis_source": segment.confidence["axis_source"],
        "span_min_deg": segment.confidence["span_min_deg"],
        "span_median_deg": segment.confidence["span_median_deg"],
        "back_coverage_low": segment.confidence["back_coverage_low"],
    }
    logger.info(
        "job %s: reconstructed %d/%d cameras, residual %.4fm, convention %s",
        job.id,
        artifacts["registered"],
        artifacts["total"],
        alignment.residual_m,
        alignment.convention,
    )
    _publish(job, ctx, settings, segment.mesh, owner, scan_id, artifacts)


def _publish(
    job: ReconstructJob,
    ctx: ReconstructContext,
    settings: Settings,
    mesh_m: trimesh.Trimesh,
    owner: str,
    scan_id: str,
    artifacts: dict[str, Any],
) -> None:
    obj = export_obj_mm(mesh_m)
    if len(obj) > settings.max_mesh_bytes:
        raise MeshValidationError(
            f"Reconstructed mesh exceeds the {settings.max_mesh_mb}MB limit. Please rescan."
        )
    # Under storage_user_id: the scans RLS WITH CHECK pins mesh_path to it (0012).
    mesh_path = f"{owner}/{scan_id}.obj"
    ctx.storage.upload(BUCKET, mesh_path, obj, content_type="model/obj")
    ctx.store.set_scan_mesh_path(job.scan_id, mesh_path)
    guard_transition(job.step, NEXT_STEP)
    ctx.store.advance(job.id, NEXT_STEP, artifacts=artifacts)


def _handle_silhouette(
    job: ReconstructJob,
    ctx: ReconstructContext,
    settings: Settings,
    bundle: CaptureBundle,
    owner: str,
    scan_id: str,
) -> None:
    prefix = f"{owner}/{scan_id}/"
    views = []
    for image in bundle.images:
        # parse_capture pinned image.file / image.mask to ^\d{3}\.(jpg|png)$.
        validate_jpeg(image, ctx.storage.download(BUCKET, f"{prefix}images/{image.file}"))
        mask = validate_mask(image, ctx.storage.download(BUCKET, f"{prefix}masks/{image.mask}"))
        views.append(
            View(
                station=str(image.station),
                mask=mask,
                camera_to_world=image.camera_to_world,
                intrinsics=image.intrinsics,
                tracking=image.tracking,
                joints=image.joints,
            )
        )
    result = reconstruct_silhouette(views, floor_y=bundle.floor_y)
    capture = bundle.capture
    artifacts = {
        **result.artifacts,
        "total": len(bundle.images),
        "mode": capture.mode if capture is not None else None,
        "finished_early": capture.finished_early if capture is not None else None,
        "coverage": capture.coverage if capture is not None else None,
    }
    logger.info(
        "job %s: silhouette from %d/%d views, residual %.4fm",
        job.id,
        artifacts["views_used"],
        artifacts["total"],
        artifacts["residual_median_m"],
    )
    _publish(job, ctx, settings, result.mesh, owner, scan_id, artifacts)
