"""Measurement extraction: PCA leg axis + four cross-section slices.

Variable NAMES and slice POSITIONS are confirmed against the Onshape model
(2026-07-02, variable table: S1_ISW..S4_OD plus Leg_Length; slices at
20/40/60/80% of Leg_Length measured from the bottom of the ankle, where
Leg_Length runs from the bottom of the ankle to the knee). The exact
ISW/ISD/ICW/ICD/OW/OD geometry definitions below are still an
interpretation, not yet verified against the model's sketch geometry with
the CAD collaborator; expect those definitions (not the names or positions)
to be refined.

Algorithm:

1. Center the mesh at its vertex centroid.
2. PCA over vertex positions (via `numpy.cov` + `numpy.linalg.eigh`). The
   eigenvector with the largest eigenvalue is treated as the leg's long
   (proximal-distal) axis. This assumes the axis of greatest positional
   variance coincides with the axis of greatest extent, true for a normal
   elongated shin scan but not guaranteed for a pathological or partial
   mesh.
3. Rotate centered vertices into a canonical (width, depth, length) frame:
   Z is the long axis; X and Y are the two remaining PCA axes ("width" and
   "depth" directions of each slice). The permutation used to build this
   frame is a cyclic permutation of the original right-handed PCA triple,
   so it stays a proper rotation (no mirroring introduced).
4. Orient Z so the NARROWER end of the mesh (smaller combined X+Y extent
   among vertices in the lowest/highest 10% of the Z range) sits at Z=0,
   and the wider end sits at Z=Leg_Length. We assume the narrower end is
   distal (ankle) and the wider end is proximal (knee), which is
   anatomically typical for a shin but not verified for any given input --
   there is no ground truth for "which end is which" in an unlabeled mesh.
   **Consequently: slice positions are measured up from the bottom of the
   ankle, so S1 is nearest the ankle and S4 nearest the knee.** This
   matches the Onshape model, whose default values grow from S1 to S4
   (a shin widens toward the knee).
5. At each slice fraction (S1=0.20, S2=0.40, S3=0.60, S4=0.80 of
   Leg_Length), cross-section the rotated mesh with the plane Z=const
   (`trimesh.Trimesh.section`) and project the resulting boundary onto X
   and Y:
   - `OW`/`OD`: full extent (max - min) of the cross-section along X and Y.
   - The section's points are split into a "medial" half (X <= mean(X) of
     that section) and a "lateral" half (X > mean(X)). Splitting at the
     section's own centroid (rather than the midpoint of its X range) means
     an asymmetric cross-section produces genuinely different numbers for
     the two halves instead of always trivially summing to OW/2.
   - `ISW`/`ICW`: the X-extent of the medial/lateral half respectively.
     By construction `ISW + ICW == OW`.
   - `ISD`/`ICD`: the Y-extent *restricted to the points in that half*.
     These are NOT required to sum to `OD`, and are expected to differ
     whenever the slice's front-back profile is not symmetric between the
     medial and lateral sides.

Units: everything is computed and returned in millimeters. See
`_detect_scale` for the meters-vs-millimeters heuristic used to handle
OBJ/PLY/GLB files, which carry no unit metadata (docs/DESIGN.md gotcha #4).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
import trimesh

from zells_pipeline.contract import MEASUREMENT_KEYS

logger = logging.getLogger(__name__)

# Bumped whenever this extraction algorithm changes in a way that affects
# output values, independent of the measurement schema version. Stored on
# every measurements row (docs/DESIGN.md section 8) so re-extractions are
# comparable rather than silently mixed with older results.
EXTRACTION_VERSION = "0.2.0"

SLICE_FRACTIONS: dict[str, float] = {"S1": 0.20, "S2": 0.40, "S3": 0.60, "S4": 0.80}

# Heuristic threshold (mesh units) below which we assume the mesh is in
# meters rather than millimeters: a real shin is 0.15-0.6m, so a bounding
# box max dimension under this value cannot plausibly already be
# millimeters. Documented heuristic, not a guarantee -- OBJ/PLY/GLB carry no
# unit metadata.
METERS_HEURISTIC_MAX_DIM = 3.0
METERS_TO_MM = 1000.0


class MeasurementError(RuntimeError):
    """Raised when a validated mesh's geometry cannot be measured.

    Distinct from `mesh_loading.MeshValidationError` (which covers
    untrusted-input hardening before this module ever sees the mesh): this
    covers cases where a structurally valid mesh nonetheless yields no
    cross-section at an expected slice position.
    """


@dataclass(frozen=True)
class ExtractionResult:
    """Extraction output: the 25 measurement values plus a scale-confidence flag."""

    values: dict[str, float]
    needs_scale_confirmation: bool


def _pca_rotation(vertices: np.ndarray) -> np.ndarray:
    """3x3 rotation taking centered vertices into a (width, depth, length) frame.

    Column 2 (Z) is the PCA axis of largest variance (assumed leg axis);
    columns 0 and 1 (X, Y) are the remaining two PCA axes.
    """
    cov = np.cov(vertices, rowvar=False)
    eigvals, eigvecs = np.linalg.eigh(cov)  # ascending eigenvalue order
    order = np.argsort(eigvals)[::-1]
    axes = eigvecs[:, order]
    # Recompute the third axis via cross product so (axis0, axis1, axis2) is
    # guaranteed right-handed regardless of eigh's arbitrary vector signs.
    axes[:, 2] = np.cross(axes[:, 0], axes[:, 1])
    # (width, depth, length) = (axis1, axis2, axis0): a cyclic permutation of
    # a right-handed triple, so this stays a proper rotation (det == +1).
    return np.column_stack([axes[:, 1], axes[:, 2], axes[:, 0]])


def _orient_long_axis(rotated: np.ndarray) -> np.ndarray:
    """Flip Z if needed so the narrower (assumed-ankle) end sits at Z=0 (see step 4 above)."""
    z = rotated[:, 2]
    z_min, z_max = float(z.min()), float(z.max())
    span = z_max - z_min
    low_mask = z <= z_min + 0.1 * span
    high_mask = z >= z_max - 0.1 * span

    def _combined_extent(mask: np.ndarray) -> float:
        pts = rotated[mask]
        if len(pts) == 0:
            return 0.0
        return float((pts[:, 0].max() - pts[:, 0].min()) + (pts[:, 1].max() - pts[:, 1].min()))

    if _combined_extent(low_mask) <= _combined_extent(high_mask):
        rotated[:, 2] = z - z_min
    else:
        rotated[:, 2] = z_max - z
    return rotated


def _detect_scale(mesh: trimesh.Trimesh) -> bool:
    """True if the mesh's bounding box suggests it is in meters, not millimeters."""
    return float(mesh.bounding_box.extents.max()) < METERS_HEURISTIC_MAX_DIM


def _slice_dims(mesh_rot: trimesh.Trimesh, z: float) -> dict[str, float]:
    section = mesh_rot.section(plane_origin=[0.0, 0.0, z], plane_normal=[0.0, 0.0, 1.0])
    if section is None:
        raise MeasurementError(
            f"No cross-section found at z={z:.1f}mm along the leg axis; mesh may be malformed "
            "or too short for the requested slice."
        )

    points = np.asarray(section.vertices)
    if len(points) == 0:
        raise MeasurementError(f"Cross-section at z={z:.1f}mm has no boundary points.")

    x, y = points[:, 0], points[:, 1]
    x_min, x_max, x_mean = float(x.min()), float(x.max()), float(x.mean())

    medial = x <= x_mean
    lateral = ~medial

    def _extent(arr: np.ndarray) -> float:
        return float(arr.max() - arr.min()) if arr.size else 0.0

    return {
        "OW": x_max - x_min,
        "OD": _extent(y),
        "ISW": x_mean - x_min,
        "ICW": x_max - x_mean,
        "ISD": _extent(y[medial]),
        "ICD": _extent(y[lateral]),
    }


def extract_measurements(mesh: trimesh.Trimesh) -> ExtractionResult:
    """Extract the 25-variable measurement set (mm) from an already-validated mesh.

    Assumes `mesh` has already passed `mesh_loading.load_mesh`'s untrusted-
    input checks (size/vertex caps, non-degenerate geometry); this function
    focuses purely on the geometry algorithm described in the module
    docstring and raises `MeasurementError` if a slice cannot be measured.
    """
    needs_scale_confirmation = _detect_scale(mesh)
    scale = METERS_TO_MM if needs_scale_confirmation else 1.0
    if needs_scale_confirmation:
        logger.warning(
            "Mesh bounding box max dimension %.4f is below the meters-scale heuristic "
            "threshold (%.1f); assuming meters and rescaling by %.0fx to millimeters. This is "
            "a heuristic guess, not a certainty -- OBJ/PLY/GLB carry no unit metadata "
            "(docs/DESIGN.md gotcha #4).",
            float(mesh.bounding_box.extents.max()),
            METERS_HEURISTIC_MAX_DIM,
            METERS_TO_MM,
        )

    vertices = mesh.vertices.astype(np.float64) * scale
    centered = vertices - vertices.mean(axis=0)

    rotation = _pca_rotation(centered)
    rotated = _orient_long_axis(centered @ rotation)

    leg_length = float(rotated[:, 2].max() - rotated[:, 2].min())
    mesh_rot = trimesh.Trimesh(vertices=rotated, faces=mesh.faces, process=False)

    values: dict[str, float] = {"Leg_Length": leg_length}
    for slice_name, fraction in SLICE_FRACTIONS.items():
        dims = _slice_dims(mesh_rot, z=fraction * leg_length)
        for dim_name, value in dims.items():
            values[f"{slice_name}_{dim_name}"] = value

    missing = set(MEASUREMENT_KEYS) - values.keys()
    if missing:  # pragma: no cover - defensive; indicates a schema/algorithm mismatch
        raise MeasurementError(f"Extraction did not produce expected keys: {sorted(missing)}")

    return ExtractionResult(values=values, needs_scale_confirmation=needs_scale_confirmation)
