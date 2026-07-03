"""Untrusted-input mesh loading (docs/DESIGN.md section 9, gotcha #6).

User-uploaded meshes are treated as hostile input: a malformed, huge, or
degenerate mesh must fail the *job*, never crash or hang the *worker*. This
module enforces, in order:

1. Extension allowlist, checked before any parsing.
2. File size cap (bytes on disk), checked before any parsing.
3. Parse via trimesh, with any parser exception converted to a typed error.
4. Post-parse vertex/face count caps (a small file can still decompress or
   tessellate into an enormous mesh).
5. Rejection of degenerate/empty meshes (no vertices, no faces, all-NaN or
   collapsed-to-a-point geometry). Watertightness is *not* required: real
   phone scans are frequently non-watertight and that alone is not a sign of
   a bad scan.

USDZ note: trimesh's default loaders (pywavefront/OBJ, PLY, GLTF) do not
include a USDZ reader; USDZ is a zipped USD package and needs a dedicated
USD toolchain (e.g. Apple's `usdz_converter` or `pxr.Usd`) to load, which is
not part of this dependency set. `.usdz` is kept in the allowlist because
capture on iOS produces USDZ (docs/DESIGN.md section 5) and the pipeline is
expected to convert USDZ to OBJ/GLB at capture/upload time, upstream of this
loader; loading a raw `.usdz` here will currently fail at the trimesh.load
call and surface as a MeshValidationError, not a silent misparse.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import trimesh

from zells_pipeline.config import Settings, get_settings

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = frozenset({".obj", ".ply", ".glb", ".usdz"})


class MeshValidationError(ValueError):
    """A mesh failed untrusted-input validation.

    The message is written to be user-facing (surfaced as the job's failure
    reason), so keep it free of stack traces or internal paths.
    """


def _check_extension(path: Path) -> None:
    suffix = path.suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        allowed = ", ".join(sorted(ALLOWED_EXTENSIONS))
        raise MeshValidationError(
            f"Unsupported file type '{suffix or '(none)'}'. Allowed types: {allowed}."
        )


def _check_file_size(path: Path, settings: Settings) -> None:
    try:
        size_bytes = path.stat().st_size
    except OSError as exc:
        raise MeshValidationError("Could not read the uploaded file.") from exc

    if size_bytes <= 0:
        raise MeshValidationError("Uploaded file is empty.")
    if size_bytes > settings.max_mesh_bytes:
        raise MeshValidationError(
            f"Mesh file is {size_bytes / (1024 * 1024):.1f}MB, which exceeds the "
            f"{settings.max_mesh_mb}MB limit."
        )


def _check_counts(mesh: trimesh.Trimesh, settings: Settings) -> None:
    if len(mesh.vertices) > settings.max_vertices:
        raise MeshValidationError(
            f"Mesh has {len(mesh.vertices):,} vertices, which exceeds the "
            f"{settings.max_vertices:,} limit. Please rescan at a lower resolution."
        )


def _check_not_degenerate(mesh: trimesh.Trimesh) -> None:
    if len(mesh.vertices) == 0 or len(mesh.faces) == 0:
        raise MeshValidationError("Mesh has no geometry (zero vertices or faces).")
    if not np.all(np.isfinite(mesh.vertices)):
        raise MeshValidationError("Mesh contains invalid (NaN or infinite) vertex coordinates.")

    extent = mesh.bounding_box.extents
    # A leg scan collapsed to (near) a single point or a flat plane on every
    # axis cannot be a real scan; treat it as degenerate rather than letting
    # PCA later fail confusingly on a rank-deficient point cloud.
    if np.count_nonzero(extent > 1e-6) < 2:
        raise MeshValidationError(
            "Mesh geometry is degenerate (collapsed to a point or line). Please rescan."
        )


def load_mesh(path: str | Path, settings: Settings | None = None) -> trimesh.Trimesh:
    """Load and validate an untrusted mesh file.

    Raises `MeshValidationError` with a user-facing reason for any failure:
    bad extension, oversized file, unparseable content, mesh too dense, or
    degenerate/empty geometry. Never raises the underlying parser exception
    directly, so callers can treat `MeshValidationError` as the single
    failure mode to catch and turn into a job failure reason.
    """
    settings = settings or get_settings()
    path = Path(path)

    _check_extension(path)
    _check_file_size(path, settings)

    try:
        loaded = trimesh.load(path, force="mesh", process=False)
    except MeshValidationError:
        raise
    except Exception as exc:
        raise MeshValidationError(
            "Could not parse the uploaded mesh file. It may be corrupt or in an unsupported format."
        ) from exc

    if isinstance(loaded, trimesh.Scene):
        # Some GLB/OBJ files load as a multi-geometry Scene; concatenate into
        # a single mesh for measurement purposes.
        geometries = list(loaded.geometry.values())
        if not geometries:
            raise MeshValidationError("Mesh file contains no geometry.")
        mesh = trimesh.util.concatenate(geometries)
    elif isinstance(loaded, trimesh.Trimesh):
        mesh = loaded
    else:
        raise MeshValidationError(f"Unsupported mesh content: {type(loaded).__name__}.")

    _check_counts(mesh, settings)
    _check_not_degenerate(mesh)

    return mesh
