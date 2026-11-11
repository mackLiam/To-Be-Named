"""Scale-free metrics of one harness run, and the agreement between two runs. Pure.

Plain video has no scale (docs/SCAN-V3-PLAN.md section 5.7), so the results lead
with ratios. Absolute values are kept only under keys starting "nominal_": they
are at the harness's nominal 400 mm leg length, never a real size.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import trimesh
from scipy import ndimage
from scipy.spatial import ConvexHull, QhullError

from forms_pipeline.extraction.measure import SLICE_FRACTIONS
from forms_pipeline.reconstruct.silhouette import MASK_THRESHOLD

SLICES = tuple(SLICE_FRACTIONS)
REFERENCE_SLICE = "S3"
PROFILE_POINTS = 21
# Profile ends sit this fraction of the length inside the ankle and knee caps.
PROFILE_END_INSET = 0.005
PROFILE_KEY = "profile (max)"
# Half-width of the vertex band behind each profile point, as a fraction of the
# length: 2 mm at the nominal 400 mm, so it spans the 2 mm silhouette ring step.
PROFILE_BAND_FRACTION = 0.005


@dataclass(frozen=True)
class MaskStats:
    area_fraction: float
    borders: tuple[str, ...]  # image sides the mask touches: top, bottom, left, right
    components: int

    @property
    def touches_border(self) -> bool:
        return bool(self.borders)


def mask_stats(mask: np.ndarray) -> MaskStats:
    """Area share, border contact and 4-connected component count of mask >= threshold."""
    leg = mask >= MASK_THRESHOLD
    _, count = ndimage.label(leg)
    sides = {"top": leg[0], "bottom": leg[-1], "left": leg[:, 0], "right": leg[:, -1]}
    borders = tuple(name for name, edge in sides.items() if edge.any())
    return MaskStats(area_fraction=float(leg.mean()), borders=borders, components=count)


def _kind_summary(stats: Sequence[MaskStats | None]) -> dict[str, Any]:
    present = [s for s in stats if s is not None]
    if not present:
        return {"frames_with_mask": 0, "median_area_fraction": None,
                "touching_border_fraction": None, "touching_side_fraction": None,
                "median_components": None}  # fmt: skip
    return {
        "frames_with_mask": len(present),
        "median_area_fraction": float(np.median([s.area_fraction for s in present])),
        "touching_border_fraction": float(np.mean([s.touches_border for s in present])),
        "touching_side_fraction": {
            side: float(np.mean([side in s.borders for s in present]))
            for side in ("top", "bottom", "left", "right")
        },
        "median_components": float(np.median([s.components for s in present])),
    }


def mask_summary(
    stats: Mapping[str, Sequence[MaskStats | None]], joints_seen: Mapping[str, int], frames: int
) -> dict[str, Any]:
    """Per mask kind: frames with a mask, median area share, share touching the image
    border, median component count; plus frames in which each joint was detected."""
    return {
        "frames": frames,
        **{kind: _kind_summary(kind_stats) for kind, kind_stats in stats.items()},
        "joints_seen": dict(sorted(joints_seen.items())),
    }


def _band_diameter(flat: np.ndarray, h: np.ndarray, center: float, half_width: float) -> float:
    pts = flat[np.abs(h - center) <= half_width]
    if len(pts) < 3:
        return float("nan")
    try:
        area = ConvexHull(pts).volume
    except QhullError:
        return float("nan")
    return float(2.0 * np.sqrt(area / np.pi))


def width_profile(
    mesh: trimesh.Trimesh, axis: np.ndarray, points: int = PROFILE_POINTS
) -> list[float]:
    """Area-equivalent diameter at `points` evenly spaced heights along axis (ankle to
    knee), divided by the largest.

    Each value is the convex hull of the vertices within PROFILE_BAND_FRACTION of the
    length of that height, not a face section: silhouette._loft can join two rings
    half a turn apart (an eigenvector sign flip), and a plane through that band cuts
    chords across the interior. The rings are ellipses, so their hull is exact."""
    axis = np.asarray(axis, dtype=np.float64)
    axis = axis / np.linalg.norm(axis)
    verts = np.asarray(mesh.vertices, dtype=np.float64)
    h = verts @ axis
    lo, hi = float(h.min()), float(h.max())
    helper = np.array([1.0, 0.0, 0.0]) if abs(axis[0]) < 0.9 else np.array([0.0, 0.0, 1.0])
    e1 = helper - (helper @ axis) * axis
    e1 /= np.linalg.norm(e1)
    flat = np.column_stack([verts @ e1, verts @ np.cross(axis, e1)])
    half = PROFILE_BAND_FRACTION * (hi - lo)
    fractions = np.linspace(PROFILE_END_INSET, 1.0 - PROFILE_END_INSET, points)
    d = np.array([_band_diameter(flat, h, lo + f * (hi - lo), half) for f in fractions])
    peak = np.nanmax(d) if np.isfinite(d).any() else np.nan
    return [float(x) for x in d / peak]


def shape_metrics(values: Mapping[str, float]) -> dict[str, Any]:
    """Per-slice OW/OD ratios from the 25 extracted values (any common scale)."""
    ow_ref, od_ref = values[f"{REFERENCE_SLICE}_OW"], values[f"{REFERENCE_SLICE}_OD"]
    slices = {}
    for s in SLICES:
        ow, od = values[f"{s}_OW"], values[f"{s}_OD"]
        slices[s] = {
            "OD/OW": od / ow,
            f"OW/OW_{REFERENCE_SLICE}": ow / ow_ref,
            f"OD/OD_{REFERENCE_SLICE}": od / od_ref,
            "nominal_OW_mm": ow,
            "nominal_OD_mm": od,
        }
    return {
        "slices": slices,
        f"Leg_Length/OW_{REFERENCE_SLICE}": values["Leg_Length"] / ow_ref,
        "nominal_Leg_Length_mm": values["Leg_Length"],
    }


def ratios(metrics: Mapping[str, Any]) -> dict[str, float]:
    """The scale-free numbers of shape_metrics (plus an optional profile), flattened."""
    out: dict[str, float] = {}
    for s, dims in metrics["slices"].items():
        for key, value in dims.items():
            if not key.startswith("nominal_"):
                out[f"{s} {key}"] = float(value)
    key = f"Leg_Length/OW_{REFERENCE_SLICE}"
    out[key] = float(metrics[key])
    return out


def agreement(a: Mapping[str, Any], b: Mapping[str, Any]) -> dict[str, Any]:
    """Absolute difference per ratio between two runs, and the largest of them.

    a and b are shape_metrics dicts, optionally with a "profile" list."""
    ra, rb = ratios(a), ratios(b)
    diffs = {k: abs(ra[k] - rb[k]) for k in ra if k in rb}
    pa, pb = a.get("profile"), b.get("profile")
    if pa is not None and pb is not None and len(pa) == len(pb):
        gap = np.abs(np.asarray(pa, dtype=np.float64) - np.asarray(pb, dtype=np.float64))
        if np.isfinite(gap).any():
            diffs[PROFILE_KEY] = float(np.nanmax(gap))
    finite = {k: v for k, v in diffs.items() if np.isfinite(v)}
    worst = max(finite, key=finite.__getitem__) if finite else None
    return {
        "diffs": diffs,
        "max": finite[worst] if worst is not None else None,
        "max_key": worst,
    }
