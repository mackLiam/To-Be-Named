"""Isolate the ankle-to-knee segment from an aligned photogrammetry mesh.

Input is in ARKit world: meters, Y up. extraction/measure.py assumes its mesh is
ONLY the ankle-to-knee segment, so everything else (background, floor, foot,
thigh) is cut away here:

1. Orbit axis: the vertical line through the capture's AR anchor when the client
   sent one (capture v2), else through the least-squares circle center of the
   camera XZ positions. A circle fit is ill-conditioned on a partial arc (a solo
   user covers half to two thirds of the circle), so it is only trusted when the
   cameras span MIN_CIRCLE_ARC_DEG and sit close to the fitted circle.
2. Keep geometry within ORBIT_RADIUS_M of that axis.
3. Drop the floor: geometry within FLOOR_CLEARANCE_M above the lowest dense band.
4. (after cropping) Angular coverage: per BIN_M slice, the span of vertex azimuths
   around the axis. Partial back coverage is recorded, never failed on.
5. Width profile from horizontal cross-sections every BIN_M. Ankle = narrowest
   bin above the foot (the wide low region) in the lower ANKLE_SEARCH_FRACTION of
   the height; calf = first width maximum above it; knee = first width minimum
   above the calf whose ankle-to-knee length is within the schema's plausible
   Leg_Length range.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import trimesh
from scipy.spatial import ConvexHull, QhullError

from forms_pipeline.contract import SCHEMA
from forms_pipeline.reconstruct import ReconstructionQualityError

# Tuning values, not physical constants: revisit against real captures.
ORBIT_RADIUS_M = 0.15
FLOOR_CLEARANCE_M = 0.015
FLOOR_SEARCH_M = 0.05
FLOOR_DENSITY_FRACTION = 0.5
BIN_M = 0.005
ANKLE_SEARCH_FRACTION = 0.4
SMOOTH_BINS = 5
EXTREMUM_WINDOW_BINS = 4
MIN_WIDTH_CHANGE_FRACTION = 0.03
MIN_CIRCLE_ARC_DEG = 200.0
MAX_CIRCLE_RESIDUAL_FRACTION = 0.15  # RMS radial residual / fitted radius
# Below this median slice span the back of the calf is missing or hallucinated,
# so downstream treats depth values (OD/ISD/ICD) as lower confidence.
BACK_COVERAGE_MIN_SPAN_DEG = 300.0

AXIS_ANCHOR = "anchor"
AXIS_CIRCLE_FIT = "circle_fit"

# Validated against the schema at import: a missing key fails loudly, and the
# range itself always comes from the schema file.
LEG_LENGTH_KEY = "Leg_Length"
LEG_LENGTH_MIN_MM = float(SCHEMA["properties"][LEG_LENGTH_KEY]["minimum"])
LEG_LENGTH_MAX_MM = float(SCHEMA["properties"][LEG_LENGTH_KEY]["maximum"])

METERS_TO_MM = 1000.0

_RESCAN = "Please rescan with the whole lower leg, from the floor to above the knee, in view."


def meters_to_mm(value: Any) -> Any:
    """The single meters -> mm conversion for reconstructed MESH GEOMETRY.

    This is not the measurement-to-CAD unit boundary (root CLAUDE.md gotcha 1,
    which stays inside the CAD provider): it puts the reconstructed mesh into the
    mm the rest of the pipeline computes in, so extraction never has to guess
    units from the bounding box.
    """
    return value * METERS_TO_MM


@dataclass(frozen=True)
class Segment:
    mesh: trimesh.Trimesh  # meters, ARKit world, cropped to [ankle, knee]
    confidence: dict[str, Any]


_NO_CIRCLE = "The camera did not circle the leg."


def fit_circle(camera_xz: np.ndarray) -> np.ndarray:
    """Least-squares (Kasa) circle center of the camera ring in the XZ plane, unchecked."""
    x, z = camera_xz[:, 0], camera_xz[:, 1]
    a = np.column_stack([x, z, np.ones_like(x)])
    b = -(x**2 + z**2)
    sol, _, rank, _ = np.linalg.lstsq(a, b, rcond=None)
    if rank < 3 or not np.all(np.isfinite(sol)):
        raise ReconstructionQualityError(f"{_NO_CIRCLE} {_RESCAN}")
    return np.array([-sol[0] / 2.0, -sol[1] / 2.0])


def angular_span_deg(xz: np.ndarray, center: np.ndarray) -> float:
    """360 minus the largest azimuth gap of the points around center (0 for < 2 points)."""
    if len(xz) < 2:
        return 0.0
    az = np.sort(np.arctan2(xz[:, 1] - center[1], xz[:, 0] - center[0]))
    gaps = np.diff(np.append(az, az[0] + 2 * np.pi))
    return float(np.degrees(2 * np.pi - gaps.max()))


def orbit_center(camera_xz: np.ndarray) -> np.ndarray:
    """Circle-fit orbit center, rejected when the fit is ill-conditioned."""
    center = fit_circle(camera_xz)
    if angular_span_deg(camera_xz, center) < MIN_CIRCLE_ARC_DEG:
        raise ReconstructionQualityError(f"{_NO_CIRCLE} {_RESCAN}")
    radii = np.hypot(camera_xz[:, 0] - center[0], camera_xz[:, 1] - center[1])
    radius = radii.mean()
    if radius <= 0 or np.sqrt(((radii - radius) ** 2).mean()) > (
        MAX_CIRCLE_RESIDUAL_FRACTION * radius
    ):
        raise ReconstructionQualityError(f"{_NO_CIRCLE} {_RESCAN}")
    return center


def slice_spans_deg(vertices: np.ndarray, center: np.ndarray) -> np.ndarray:
    """Azimuth span of vertices around the vertical axis at center, per BIN_M slice.

    Empty slices are skipped, not reported as zero.
    """
    y = vertices[:, 1]
    bins = np.floor((y - y.min()) / BIN_M).astype(np.int64)
    xz = vertices[:, [0, 2]]
    return np.array([angular_span_deg(xz[bins == b], center) for b in np.unique(bins)])


def _submesh(mesh: trimesh.Trimesh, keep: np.ndarray) -> trimesh.Trimesh:
    faces = mesh.faces[keep[mesh.faces].all(axis=1)]
    out = trimesh.Trimesh(vertices=mesh.vertices, faces=faces, process=False)
    out.remove_unreferenced_vertices()
    return out


def floor_height(y: np.ndarray) -> float | None:
    """Height of the lowest dense horizontal band near the bottom, or None if absent."""
    edges = np.arange(y.min(), y.max() + BIN_M, BIN_M)
    if len(edges) < 2:
        return None
    counts, edges = np.histogram(y, bins=edges)
    dense = np.flatnonzero(counts >= FLOOR_DENSITY_FRACTION * counts.max())
    lowest = int(dense[0])
    if edges[lowest] - y.min() > FLOOR_SEARCH_M:
        return None
    in_band = y[(y >= edges[lowest]) & (y <= edges[lowest + 1])]
    return float(np.median(in_band))


def width_profile(mesh: trimesh.Trimesh, heights: np.ndarray) -> np.ndarray:
    """Equivalent diameter (sqrt(4A/pi) of the section's convex hull) at each height.

    Rotation-invariant, so it does not depend on which way the foot points.
    """
    lines, _, _ = trimesh.intersections.mesh_multiplane(
        mesh, plane_origin=[0.0, 0.0, 0.0], plane_normal=[0.0, 1.0, 0.0], heights=heights
    )
    widths = np.full(len(heights), np.nan)
    for i, segs in enumerate(lines):
        pts = np.asarray(segs).reshape(-1, 2)
        if len(pts) < 3:
            continue
        try:
            widths[i] = np.sqrt(4.0 * ConvexHull(pts).volume / np.pi)
        except QhullError:
            continue
    return widths


def _smooth(w: np.ndarray) -> np.ndarray:
    kernel = np.ones(SMOOTH_BINS) / SMOOTH_BINS
    padded = np.pad(w, SMOOTH_BINS // 2, mode="edge")
    return np.convolve(padded, kernel, mode="valid")


def _is_extremum(w: np.ndarray, i: int, fn: Any) -> bool:
    lo, hi = i - EXTREMUM_WINDOW_BINS, i + EXTREMUM_WINDOW_BINS + 1
    if lo < 0 or hi > len(w):
        return False
    return bool(w[i] == fn(w[lo:hi]))


def find_landmarks(widths: np.ndarray) -> tuple[int | None, int | None, int | None]:
    """(ankle, calf, knee) bin indices into a smoothed width profile; None if absent."""
    n = len(widths)
    lower_end = max(int(ANKLE_SEARCH_FRACTION * n), 1)
    foot = int(np.argmax(widths[:lower_end]))
    ankle = foot + int(np.argmin(widths[foot:lower_end]))
    if ankle == foot or not widths[ankle] < widths[foot] * (1 - MIN_WIDTH_CHANGE_FRACTION):
        return None, None, None
    if not _is_extremum(widths, ankle, np.min):
        return None, None, None

    calf = next(
        (
            i
            for i in range(ankle + 1, n)
            if _is_extremum(widths, i, np.max)
            and widths[i] > widths[ankle] * (1 + MIN_WIDTH_CHANGE_FRACTION)
        ),
        None,
    )
    if calf is None:
        return ankle, None, None

    for i in range(calf + 1, n):
        length_mm = meters_to_mm((i - ankle) * BIN_M)
        if length_mm > LEG_LENGTH_MAX_MM:
            break
        if (
            length_mm >= LEG_LENGTH_MIN_MM
            and _is_extremum(widths, i, np.min)
            and widths[i] < widths[calf] * (1 - MIN_WIDTH_CHANGE_FRACTION)
        ):
            return ankle, calf, i
    return ankle, calf, None


def segment_leg(
    mesh: trimesh.Trimesh,
    camera_positions: np.ndarray,
    anchor_world: np.ndarray | None = None,
) -> Segment:
    """Crop an aligned (ARKit world, meters) mesh to the ankle-to-knee segment.

    anchor_world must already be in the mesh's frame (ARKit world); only its XZ
    is used, the axis is vertical.
    """
    if anchor_world is not None:
        center, axis_source = np.asarray(anchor_world, dtype=np.float64)[[0, 2]], AXIS_ANCHOR
    else:
        center, axis_source = orbit_center(camera_positions[:, [0, 2]]), AXIS_CIRCLE_FIT
    v = mesh.vertices
    radial = np.hypot(v[:, 0] - center[0], v[:, 2] - center[1])
    keep = radial <= ORBIT_RADIUS_M
    if keep.sum() < 3:
        raise ReconstructionQualityError(f"No leg was found in the middle of the scan. {_RESCAN}")

    floor = floor_height(v[keep, 1])
    if floor is not None:
        keep &= v[:, 1] > floor + FLOOR_CLEARANCE_M
    leg = _submesh(mesh, keep)
    if len(leg.faces) == 0:
        raise ReconstructionQualityError(f"No leg was found in the middle of the scan. {_RESCAN}")

    y_min, y_max = leg.bounds[0, 1], leg.bounds[1, 1]
    heights = np.arange(y_min + BIN_M / 2, y_max, BIN_M)
    raw = width_profile(leg, heights)
    valid = np.isfinite(raw)
    if valid.sum() < 2:
        raise ReconstructionQualityError(f"No leg was found in the middle of the scan. {_RESCAN}")
    widths = _smooth(np.interp(np.arange(len(raw)), np.flatnonzero(valid), raw[valid]))

    ankle, calf, knee = find_landmarks(widths)
    if ankle is None:
        raise ReconstructionQualityError(f"The ankle could not be found. {_RESCAN}")
    if knee is None:
        raise ReconstructionQualityError(f"The knee could not be found. {_RESCAN}")

    ankle_y, knee_y = float(heights[ankle]), float(heights[knee])
    cropped = trimesh.intersections.slice_mesh_plane(leg, [0, 1, 0], [0, ankle_y, 0])
    cropped = trimesh.intersections.slice_mesh_plane(cropped, [0, -1, 0], [0, knee_y, 0])
    if len(cropped.faces) == 0:
        raise ReconstructionQualityError(f"No leg was found in the middle of the scan. {_RESCAN}")

    spans = slice_spans_deg(np.asarray(cropped.vertices), center)
    span_median = float(np.median(spans))
    confidence = {
        "axis_source": axis_source,
        "span_min_deg": float(spans.min()),
        "span_median_deg": span_median,
        "back_coverage_low": span_median < BACK_COVERAGE_MIN_SPAN_DEG,
        "ankle_found": True,
        "knee_found": True,
        "floor_found": floor is not None,
        "bins": len(heights),
        "empty_bins": int((~valid).sum()),
        "ankle_height_m": float(ankle_y - y_min),
        "knee_height_m": float(knee_y - y_min),
        "ankle_width_m": float(widths[ankle]),
        "calf_width_m": float(widths[calf]),
        "knee_width_m": float(widths[knee]),
    }
    return Segment(mesh=cropped, confidence=confidence)
