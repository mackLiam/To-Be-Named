"""Shape from silhouette: 4..12 masked station photos -> metric ankle-to-knee mesh.

Pure numpy/scipy, no IO. Output matches the photogrammetry path's hand-off to the
measuring step: a closed mesh in ARKit world meters, cropped to [ankle, knee],
not reoriented (extraction's PCA orients it; handler.export_obj_mm converts to mm).

Camera and pixel convention (the iOS writer must match it exactly):
- camera_to_world maps camera space to ARKit world (meters, gravity aligned, +Y up).
- Camera space: +X is image right, +Y is image up, the camera looks down -Z.
- Pixels are those of the WRITTEN image in sensor orientation (ARFrame.capturedImage,
  landscape, never rotated for the UI). u is the column (grows right), v is the row
  (grows down); pixel (row r, column c) has its center at (u, v) = (c, r).
- A camera-space point (x, y, z) with z < 0 projects to
      u = cx + fx * x / -z        v = cy - fy * y / -z
  so v grows opposite to camera +Y. Intrinsics refer to the written size.
- mask[row, column] >= 128 is leg. The mask has the photo's exact size.
Nothing assumes which way the leg runs in the image: a phone held upright puts the
leg along the sensor's long (u) axis.

Algorithm:
1. Per view, binarize the mask and keep its largest 4-connected component.
2. Leg axis, a 3D line (a seated shin is not vertical): each view's mask centerline
   back-projects to a plane through its camera center; the axis is the least-squares
   intersection of those planes.
3. Every STEP_M along the axis, in the plane perpendicular to it: project the axis
   point, cut the mask across the projected axis and take both edges, fitted over
   +-EDGE_WINDOW_PX along the axis so each edge has a tangent direction. Two pixels on
   an edge and the camera center span a plane tangent to the leg; its intersection
   with the slice plane is a tangent line of that cross-section.
4. Per slice, fit an ellipse to the tangent lines through the dual conic
   (l^T C* l = 0, 6 unknowns, SVD), with one pass of residual-based outlier rejection.
5. Smooth along the axis, find ankle and knee with segment.profile_landmarks (the
   photogrammetry path's rule), crop, and loft a closed mesh. When the photos carry
   on-device body-pose joints, the triangulated ankle and knee seed the search: the
   cut is the narrowest smoothed width within JOINT_WINDOW_M of each joint, so the
   silhouette profile still decides it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import trimesh
from scipy import ndimage

from forms_pipeline.reconstruct import ReconstructionQualityError
from forms_pipeline.reconstruct.segment import (
    BIN_M,
    LEG_LENGTH_MAX_MM,
    LEG_LENGTH_MIN_MM,
    angular_span_deg,
    meters_to_mm,
    profile_landmarks,
)

METHOD = "silhouette"
TRUSTED_TRACKING = "normal"  # a pose ARKit flags as limited is not metric enough

# Tuning values, not physical constants: revisit against real captures.
MASK_THRESHOLD = 128
MIN_MASK_AREA_FRACTION = 0.005
MAX_MASK_AREA_FRACTION = 0.8
MIN_VIEWS = 3
MIN_SPAN_DEG = 120.0
MAX_TILT_DEG = 30.0
# Second / first singular value of the centerline-plane normals: below this the
# views are too close in direction for the axis to be triangulated.
MIN_AXIS_CONDITION = 0.2
STEP_M = 0.002
EDGE_WINDOW_PX = 10
CENTERLINE_CUTS = 15
CENTERLINE_RANGE = (0.25, 0.75)  # of the mask's length: clear of foot and frame edge
CUTOFF_MAX_FRACTION = 0.1
OUTLIER_FACTOR = 3.0
OUTLIER_FLOOR_M = 0.001
MAX_MEDIAN_RESIDUAL_M = 0.004
FLOOR_CLEARANCE_M = 0.01
SWEEP_BELOW_M = 1.5  # axis range searched, relative to the cameras' mean height
SWEEP_ABOVE_M = 1.0
MIN_SEMI_AXIS_M = 0.01
# Per-view pose refinement: ARKit's pose error (about a degree) moves a view's
# outline by ~9 mm at 0.5 m, more than the leg's own detail, so each view's lines
# are corrected (see _refine_views). A correction beyond the caps means the poses
# genuinely disagree.
REFINE_ITERATIONS = 10
REFINE_TOLERANCE = 1e-2  # step size in units of the finite-difference epsilons
MAX_VIEW_CORRECTION_DEG = 3.0
MAX_VIEW_SHIFT_M = 0.02
REFINE_RESIDUAL_SIGMA_M = 0.0005
# Prior on (angle rad, angle rate rad/m, axis shift m): about ARKit's pose error.
REFINE_PRIOR_SIGMA = np.array([np.radians(1.0), np.radians(3.0) / 0.3, 0.009])
# Edge search reach from the axis: the foot runs ~0.2 m forward of the ankle axis
# and must stay inside it, or the foot (the ankle rule's reference) is lost.
SEARCH_RADIUS_M = 0.3
SMOOTH_STEPS = 5
MAX_GAP_STEPS = 10
MIN_PROFILE_BINS = 10
RING_POINTS = 64
JOINT_MIN_CONFIDENCE = 0.5
JOINT_WINDOW_M = 0.04
# A joint ray farther than this from the joint's triangulated point is dropped.
JOINT_OUTLIER_M = 0.02
_FIT_SCALE_M = 0.05  # conditions the dual-conic system (lines in ~unit coordinates)
_SCAN_CHUNK = 32

_RETAKE = "Please retake the photos."
_DISAGREE = "The leg outlines in the photos do not agree; hold the phone steady."


@dataclass(frozen=True)
class View:
    station: str
    mask: np.ndarray  # (height, width) uint8, same size as the photo
    camera_to_world: np.ndarray  # 4x4, ARKit world meters
    intrinsics: tuple[float, float, float, float]  # fx, fy, cx, cy
    tracking: str = TRUSTED_TRACKING
    # Optional on-device body pose: name -> (u, v, confidence) in this view's pixels.
    joints: Mapping[str, tuple[float, float, float] | None] | None = None


@dataclass(frozen=True)
class SilhouetteResult:
    mesh: trimesh.Trimesh  # ARKit world meters, cropped to [ankle, knee]
    artifacts: dict[str, Any]


@dataclass(frozen=True)
class Ellipse:
    center: np.ndarray  # (2,) slice-plane coordinates, meters
    shape: np.ndarray  # (2, 2) S: boundary is {c + x : x^T S^-1 x = 1}
    residuals: np.ndarray  # per tangent line, meters


def _retake(reason: str) -> ReconstructionQualityError:
    return ReconstructionQualityError(f"{reason} {_RETAKE}")


def _cut_off(view: View) -> ReconstructionQualityError:
    return _retake(
        f"The leg is cut off at the edge of the {view.station} photo; keep the whole leg "
        "inside the frame."
    )


def project(
    c2w: np.ndarray, intrinsics: tuple[float, float, float, float], points: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """World points (N, 3) -> pixels (N, 2) and depth in front of the camera (N,)."""
    fx, fy, cx, cy = intrinsics
    cam = (points - c2w[:3, 3]) @ c2w[:3, :3]
    depth = -cam[:, 2]
    with np.errstate(divide="ignore", invalid="ignore"):
        uv = np.column_stack([cx + fx * cam[:, 0] / depth, cy - fy * cam[:, 1] / depth])
    return uv, depth


def ray_directions(
    c2w: np.ndarray, intrinsics: tuple[float, float, float, float], uv: np.ndarray
) -> np.ndarray:
    """Pixels (N, 2) -> world ray directions (N, 3) from the camera center, unnormalized."""
    fx, fy, cx, cy = intrinsics
    cam = np.column_stack([(uv[:, 0] - cx) / fx, -(uv[:, 1] - cy) / fy, -np.ones(len(uv))])
    return cam @ c2w[:3, :3].T


def leg_component(mask: np.ndarray) -> np.ndarray | None:
    """Largest 4-connected component of mask >= MASK_THRESHOLD, or None if implausible."""
    labels, count = ndimage.label(mask >= MASK_THRESHOLD)  # default structure: 4-connected
    if count == 0:
        return None
    sizes = np.bincount(labels.ravel())[1:]
    if not MIN_MASK_AREA_FRACTION <= sizes.max() / mask.size <= MAX_MASK_AREA_FRACTION:
        return None
    return labels == int(np.argmax(sizes)) + 1


def _scan(
    leg: np.ndarray,
    origins: np.ndarray,
    along: np.ndarray,
    perp: np.ndarray,
    offsets: np.ndarray,
    half_len: int,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Edges of the run through each cut center, for [left, right] = [-perp, +perp].

    For N cuts and K offsets along the leg returns, per side, (t, hit) of shape
    (N, K): t is the subpixel edge distance from the cut center along perp (NaN if
    the center is outside the leg or no edge lies within half_len) and hit marks
    edges that are the image border, i.e. the leg runs out of frame there.
    """
    h, w = leg.shape
    t = np.arange(-half_len, half_len + 1, dtype=np.float64)
    pts = (
        origins[:, None, None, :]
        + offsets[None, :, None, None] * along[:, None, None, :]
        + t[None, None, :, None] * perp[:, None, None, :]
    )
    u, v = pts[..., 0], pts[..., 1]
    vals = ndimage.map_coordinates(
        leg, [v.ravel(), u.ravel()], order=1, mode="constant", cval=0.0
    ).reshape(u.shape)
    outside_image = (u < 0) | (u > w - 1) | (v < 0) | (v > h - 1)
    inside = vals >= 0.5
    out = []
    for sign in (-1, 1):
        idx = half_len + sign * np.arange(half_len + 1)  # center outward
        ins = inside[..., idx]
        ok = ins[..., 0] & ~ins.all(axis=-1)
        step = np.where(ok, np.argmax(~ins, axis=-1), 1)  # first step outside the leg
        i_out = (half_len + sign * step)[..., None]
        i_in = i_out - sign
        v_in = np.take_along_axis(vals, i_in, -1)[..., 0]
        v_out = np.take_along_axis(vals, i_out, -1)[..., 0]
        frac = (v_in - 0.5) / np.where(ok, v_in - v_out, 1.0)  # v_in >= 0.5 > v_out
        edge = np.where(ok, sign * (step - 1 + frac), np.nan)
        hit = ok & np.take_along_axis(outside_image, i_out, -1)[..., 0]
        out.append((edge, hit))
    return out


def _centerline_normal(view: View, leg: np.ndarray) -> tuple[np.ndarray | None, bool]:
    """Unit normal of the plane through the camera center and the mask's centerline
    (None if it cannot be traced), and whether the leg runs into the image border."""
    rows, cols = np.nonzero(leg[::4, ::4])
    pts = np.column_stack([cols, rows]).astype(np.float64) * 4.0
    mean = pts.mean(axis=0)
    direction = np.linalg.svd(pts - mean, full_matrices=False)[2][0]
    q = (pts - mean) @ direction
    reach = q.min() + np.linspace(*CENTERLINE_RANGE, CENTERLINE_CUTS) * (q.max() - q.min())
    origins = mean + reach[:, None] * direction
    perp = np.array([-direction[1], direction[0]])
    n = len(origins)
    (left, hit_l), (right, hit_r) = _scan(
        leg.astype(np.float32),
        origins,
        np.tile(direction, (n, 1)),
        np.tile(perp, (n, 1)),
        np.zeros(1),
        int(np.hypot(*leg.shape)),
    )
    left, right = left[:, 0], right[:, 0]
    border = hit_l[:, 0] | hit_r[:, 0]
    cut_off = bool(border.sum() > CUTOFF_MAX_FRACTION * CENTERLINE_CUTS)
    ok = np.isfinite(left) & np.isfinite(right) & ~border
    if ok.sum() < CENTERLINE_CUTS // 2:
        return None, cut_off
    mids = origins[ok] + ((left[ok] + right[ok]) / 2)[:, None] * perp
    mid = mids.mean(axis=0)
    line_dir = np.linalg.svd(mids - mid, full_matrices=False)[2][0]
    rays = ray_directions(
        view.camera_to_world, view.intrinsics, np.array([mid, mid + 100.0 * line_dir])
    )
    normal = np.cross(rays[0], rays[1])
    return normal / np.linalg.norm(normal), cut_off


def triangulate_axis(normals: np.ndarray, centers: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Least-squares line in all planes n_i . (X - C_i) = 0: (point, unit direction, +Y up).

    The point is the axis point level (along the axis) with the cameras' mean.
    """
    _, sv, vt = np.linalg.svd(normals)
    if sv[1] < MIN_AXIS_CONDITION * sv[0]:
        raise _retake("The photos were all taken from nearly the same direction.")
    direction = vt[2] if vt[2][1] >= 0 else -vt[2]
    a = np.vstack([normals, direction])
    b = np.append((normals * centers).sum(axis=1), direction @ centers.mean(axis=0))
    return np.linalg.lstsq(a, b, rcond=None)[0], direction


def _slice_frame(axis: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """e1, e2 spanning the plane perpendicular to axis, (e1, e2, axis) right-handed."""
    e1 = np.array([1.0, 0.0, 0.0]) - axis[0] * axis  # axis is within MAX_TILT_DEG of +Y
    e1 /= np.linalg.norm(e1)
    return e1, np.cross(axis, e1)


def _view_lines(
    view: View,
    leg: np.ndarray,
    origin: np.ndarray,
    frame: tuple[np.ndarray, np.ndarray, np.ndarray],
    s: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Tangent lines (S, 2, 3) as (a, b, c) with a x + b y + c = 0 in slice coordinates,
    unit (a, b), NaN where missing; plus per slice: axis point on the leg, edge at border.
    """
    e1, e2, axis = frame
    c2w, intr = view.camera_to_world, view.intrinsics
    h, w = leg.shape
    points = origin + s[:, None] * axis
    p0, depth = project(c2w, intr, points)
    p1, depth1 = project(c2w, intr, points + 0.01 * axis)
    along = p1 - p0
    lines = np.full((len(s), 2, 3), np.nan)
    on_leg = np.zeros(len(s), dtype=bool)
    at_border = np.zeros(len(s), dtype=bool)
    with np.errstate(invalid="ignore", divide="ignore"):
        along /= np.linalg.norm(along, axis=1, keepdims=True)
        margin = EDGE_WINDOW_PX + 2
        ends = np.concatenate([p0 - margin * along, p0 + margin * along], axis=1)
        ok = (depth > 0.05) & (depth1 > 0.05) & np.isfinite(ends).all(axis=1)
        ok &= (ends[:, [0, 2]].min(axis=1) >= 0) & (ends[:, [0, 2]].max(axis=1) <= w - 1)
        ok &= (ends[:, [1, 3]].min(axis=1) >= 0) & (ends[:, [1, 3]].max(axis=1) <= h - 1)
    idx = np.flatnonzero(ok)
    centers_px = np.rint(p0[idx]).astype(np.int64)
    idx = idx[leg[centers_px[:, 1], centers_px[:, 0]]]
    on_leg[idx] = True
    if len(idx) == 0:
        return lines, on_leg, at_border

    perp = np.column_stack([-along[:, 1], along[:, 0]])
    half_len = int(np.ceil(SEARCH_RADIUS_M * max(intr[0], intr[1]) / depth[idx].min()))
    k = np.arange(-EDGE_WINDOW_PX, EDGE_WINDOW_PX + 1, dtype=np.float64)
    legf = leg.astype(np.float32)
    cam_center = c2w[:3, 3]
    for start in range(0, len(idx), _SCAN_CHUNK):
        sel = idx[start : start + _SCAN_CHUNK]
        sides = _scan(legf, p0[sel], along[sel], perp[sel], k, half_len)
        for side, (t, hit) in enumerate(sides):
            at_border[sel] |= hit.any(axis=1)
            valid = np.isfinite(t) & ~hit
            wts = valid.astype(np.float64)
            tv = np.where(valid, t, 0.0)
            n, sk, skk = wts.sum(1), (wts * k).sum(1), (wts * k * k).sum(1)
            st, skt = tv.sum(1), (tv * k).sum(1)
            det = n * skk - sk * sk
            good = (n >= EDGE_WINDOW_PX + 1) & ~hit.any(axis=1) & (det > 0)
            det = np.where(good, det, 1.0)
            slope = (n * skt - sk * st) / det
            icpt = (st - slope * sk) / np.where(good, n, 1.0)
            pa = p0[sel] + (-k[-1]) * along[sel] + (icpt - slope * k[-1])[:, None] * perp[sel]
            pb = p0[sel] + k[-1] * along[sel] + (icpt + slope * k[-1])[:, None] * perp[sel]
            normal = np.cross(ray_directions(c2w, intr, pa), ray_directions(c2w, intr, pb))
            a, b = normal @ e1, normal @ e2
            c = (origin - cam_center) @ normal.T + s[sel] * (normal @ axis)
            norm_ab = np.hypot(a, b)
            # A tangent plane nearly parallel to the slice plane gives no usable line.
            good &= norm_ab > 0.2 * np.linalg.norm(normal, axis=1)
            norm_ab = np.where(good, norm_ab, 1.0)
            coeffs = np.column_stack([a, b, c]) / norm_ab[:, None]
            lines[sel[good], side] = coeffs[good]
    return lines, on_leg, at_border


def fit_ellipse(lines: np.ndarray) -> Ellipse | None:
    """Ellipse tangent (least squares, algebraic) to lines (M >= 5, 3), unit (a, b); None
    when the dual conic is not a real ellipse."""
    a, b, c = lines[:, 0], lines[:, 1], lines[:, 2] / _FIT_SCALE_M
    design = np.column_stack([a * a, 2 * a * b, b * b, 2 * a * c, 2 * b * c, c * c])
    q = np.linalg.svd(design)[2][-1]
    if abs(q[5]) < 1e-9:
        return None
    # Dual conic of an ellipse (center m, shape S), scaled so the last entry is -1:
    # [[S - m m^T, -m], [-m^T, -1]].
    q = q / -q[5]
    center = -q[3:5]
    shape = np.array([[q[0], q[1]], [q[1], q[2]]]) + np.outer(center, center)
    if not np.all(np.isfinite(shape)) or np.linalg.eigvalsh(shape).min() <= 0:
        return None
    center, shape = center * _FIT_SCALE_M, shape * _FIT_SCALE_M**2
    normals = lines[:, :2]
    support = np.sqrt(np.einsum("ni,ij,nj->n", normals, shape, normals))
    residuals = np.abs(np.abs(normals @ center + lines[:, 2]) - support)
    return Ellipse(center=center, shape=shape, residuals=residuals)


def _fit_slice(lines: np.ndarray) -> Ellipse | None:
    fit = fit_ellipse(lines)
    if fit is None:
        return None
    keep = fit.residuals <= max(OUTLIER_FACTOR * float(np.median(fit.residuals)), OUTLIER_FLOOR_M)
    if not keep.all():
        if keep.sum() < 2 * MIN_VIEWS:
            return None
        fit = fit_ellipse(lines[keep])
        if fit is None:
            return None
    semi = np.sqrt(np.linalg.eigvalsh(fit.shape))
    if semi.min() < MIN_SEMI_AXIS_M or semi.max() > SEARCH_RADIUS_M:
        return None
    if np.linalg.norm(fit.center) > SEARCH_RADIUS_M:
        return None
    return fit


def _fit_slices(lines: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per slice of lines (V, S, 2, 3): params (S, 5) = (cx, cy, Sxx, Sxy, Syy) and RMS
    residual (S,), NaN where fewer than MIN_VIEWS views see the slice or the fit fails."""
    n_slices = lines.shape[1]
    params = np.full((n_slices, 5), np.nan)
    rms = np.full(n_slices, np.nan)
    seen = np.isfinite(lines[..., 0]).any(axis=2).sum(axis=0)
    for j in np.flatnonzero(seen >= MIN_VIEWS):
        slice_lines = lines[:, j].reshape(-1, 3)
        found = np.isfinite(slice_lines[:, 0])
        if found.sum() < 2 * MIN_VIEWS:
            continue
        fit = _fit_slice(slice_lines[found])
        if fit is not None:
            sh = fit.shape
            params[j] = [fit.center[0], fit.center[1], sh[0, 0], sh[0, 1], sh[1, 1]]
            rms[j] = float(np.sqrt(np.mean(fit.residuals**2)))
    return params, rms


def _rotate_lines(lines: np.ndarray, pivot: np.ndarray, angle: Any) -> np.ndarray:
    """Lines (S, 2, 3) rotated about pivot in the slice plane; angle scalar or (S, 1)."""
    c, s = np.cos(angle), np.sin(angle)
    n = lines[..., :2]
    rn = np.stack([c * n[..., 0] - s * n[..., 1], s * n[..., 0] + c * n[..., 1]], axis=-1)
    offset = lines[..., 2] + n @ pivot - rn @ pivot
    return np.concatenate([rn, offset[..., None]], axis=-1)


def _shift_lines(lines: np.ndarray, shift_m: float) -> np.ndarray:
    """Lines (S, 2, 3) resampled so slice j takes the line found at s_j + shift_m.

    Exact for a view displaced along the axis: the line formula carries s, so a
    tangent plane moved by -shift along the axis meets slice s where it met s + shift.
    """
    steps = shift_m / STEP_M
    base = int(np.floor(steps))
    frac = steps - base
    idx = np.arange(len(lines)) + base
    ok = (idx >= 0) & (idx + 1 < len(lines))
    out = np.full_like(lines, np.nan)
    lo, hi = lines[idx[ok]], lines[idx[ok] + 1]
    mixed = (1.0 - frac) * lo + frac * hi
    out[ok] = mixed / np.hypot(mixed[..., 0], mixed[..., 1])[..., None]
    return out


def _signed_residuals(lines: np.ndarray, params: np.ndarray) -> np.ndarray:
    """Lines (S, 2, 3) vs ellipses (S, 5): + outside the ellipse, - cutting it."""
    n = lines[..., :2]
    dist = n[..., 0] * params[:, None, 0] + n[..., 1] * params[:, None, 1] + lines[..., 2]
    support = np.sqrt(
        n[..., 0] ** 2 * params[:, None, 2]
        + 2 * n[..., 0] * n[..., 1] * params[:, None, 3]
        + n[..., 1] ** 2 * params[:, None, 4]
    )
    return np.abs(dist) - support


def _correct_view(
    lines: np.ndarray, pivot: np.ndarray, s_rel: np.ndarray, p: np.ndarray
) -> np.ndarray:
    """Apply view correction p = (angle, angle per meter along the axis, axis shift)."""
    angle = (p[0] + p[1] * s_rel)[:, None]
    return _rotate_lines(_shift_lines(lines, p[2]), pivot, angle)


def _refine_views(
    lines: np.ndarray, pivots: np.ndarray, s: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Per-view pose correction making all views' tangent lines agree.

    Each view i gets p_i = (angle, angle rate, shift): a rotation about the line
    through its camera parallel to the axis, varying linearly along the axis (the
    sideways part of a yaw and roll error), and a shift along the axis (pitch).
    Depth error is left alone: a common one is indistinguishable from leg scale.
    Gauss-Newton per view against the current fits, all views updated together.
    Returns corrected lines, their fits (params, rms) and the peak correction per
    view as (V, 2): degrees of rotation, meters of shift.
    """
    n_views = len(lines)
    seen = np.isfinite(lines[..., 0]).any(axis=2)
    s_mid = np.array([s[row].mean() if row.any() else 0.0 for row in seen])
    p = np.zeros((n_views, 3))
    eps = np.array([1e-4, 1e-3, 1e-4])
    current = lines
    params, rms = _fit_slices(current)
    for _ in range(REFINE_ITERATIONS):
        if not np.isfinite(params[:, 0]).any():
            break
        step = np.zeros_like(p)
        for i in range(n_views):
            s_rel = s - s_mid[i]
            r0 = _signed_residuals(_correct_view(lines[i], pivots[i], s_rel, p[i]), params)
            jac = np.stack(
                [
                    (_signed_residuals(
                        _correct_view(lines[i], pivots[i], s_rel, p[i] + eps * np.eye(3)[k]),
                        params,
                    ) - r0) / eps[k]
                    for k in range(3)
                ],
                axis=-1,
            )  # fmt: skip
            ok = np.isfinite(r0) & np.isfinite(jac).all(axis=-1)
            if ok.sum() < 2 * MIN_PROFILE_BINS:
                continue
            ok &= np.abs(r0) <= max(
                OUTLIER_FACTOR * float(np.median(np.abs(r0[ok]))), OUTLIER_FLOOR_M
            )
            # MAP step: residuals at REFINE_RESIDUAL_SIGMA_M plus a zero-mean prior on
            # the correction, so directions the lines barely constrain stay near zero.
            design = np.vstack(
                [jac[ok] / REFINE_RESIDUAL_SIGMA_M, np.diag(1.0 / REFINE_PRIOR_SIGMA)]
            )
            target = np.concatenate([-r0[ok] / REFINE_RESIDUAL_SIGMA_M, -p[i] / REFINE_PRIOR_SIGMA])
            step[i] = np.linalg.lstsq(design, target, rcond=None)[0]
        p += step
        current = np.stack(
            [_correct_view(lines[i], pivots[i], s - s_mid[i], p[i]) for i in range(n_views)]
        )
        params, rms = _fit_slices(current)
        if np.abs(step / eps).max() < REFINE_TOLERANCE:
            break
    peak = np.zeros((n_views, 2))
    for i in range(n_views):
        s_rel = s[seen[i]] - s_mid[i] if seen[i].any() else np.zeros(1)
        peak[i] = [np.degrees(np.abs(p[i, 0] + p[i, 1] * s_rel).max()), abs(p[i, 2])]
    return current, params, rms, peak


def triangulate_point(
    centers: np.ndarray, dirs: np.ndarray
) -> tuple[np.ndarray, np.ndarray] | None:
    """Least-squares intersection of rays (k, 3), dropping the farthest ray while it is
    more than JOINT_OUTLIER_M off. Returns (point, kept mask) or None."""
    dirs = dirs / np.linalg.norm(dirs, axis=1, keepdims=True)
    keep = np.ones(len(dirs), dtype=bool)
    while keep.sum() >= 2:
        proj = np.eye(3)[None] - dirs[keep, :, None] * dirs[keep, None, :]
        a = proj.sum(axis=0)
        if np.linalg.cond(a) > 1e6:
            return None
        point = np.linalg.solve(a, np.einsum("kij,kj->i", proj, centers[keep]))
        off = np.linalg.norm(np.einsum("kij,kj->ki", proj, point - centers[keep]), axis=1)
        if off.max() <= JOINT_OUTLIER_M:
            return point, keep
        keep[np.flatnonzero(keep)[int(np.argmax(off))]] = False
    return None


def _joint_seeds(
    usable: Sequence[tuple[View, np.ndarray, np.ndarray]], origin: np.ndarray, axis: np.ndarray
) -> tuple[dict[str, float], int]:
    """Axis position of each triangulated joint, and how many views contributed."""
    seeds: dict[str, float] = {}
    used: set[int] = set()
    for name in ("ankle", "knee"):
        idx, centers, dirs = [], [], []
        for i, (view, _, _) in enumerate(usable):
            joint = (view.joints or {}).get(name)
            if joint is None or joint[2] < JOINT_MIN_CONFIDENCE:
                continue
            ray = ray_directions(view.camera_to_world, view.intrinsics, np.array([joint[:2]]))
            idx.append(i)
            centers.append(view.camera_to_world[:3, 3])
            dirs.append(ray[0])
        if len(idx) < 2:
            continue
        found = triangulate_point(np.array(centers), np.array(dirs))
        if found is not None:
            seeds[name] = float(axis @ (found[0] - origin))
            used.update(np.array(idx)[found[1]].tolist())
    return seeds, len(used)


def _seeded_minimum(widths: np.ndarray, grid: np.ndarray, seed: float) -> int | None:
    """Narrowest bin within JOINT_WINDOW_M of seed, if it is an interior minimum."""
    window = np.flatnonzero(np.abs(grid - seed) <= JOINT_WINDOW_M)
    if len(window) < 3:
        return None
    best = int(window[np.argmin(widths[window])])
    return best if window[0] < best < window[-1] else None


def _longest_run(valid: np.ndarray) -> slice:
    idx = np.flatnonzero(valid)
    groups = np.split(idx, np.flatnonzero(np.diff(idx) > MAX_GAP_STEPS) + 1)
    best = max(groups, key=lambda g: g[-1] - g[0])
    return slice(int(best[0]), int(best[-1]) + 1)


def _loft(
    s: np.ndarray,
    params: np.ndarray,
    origin: np.ndarray,
    frame: tuple[np.ndarray, np.ndarray, np.ndarray],
) -> trimesh.Trimesh:
    """Closed mesh through ellipse rings params (R, 5) = (cx, cy, Sxx, Sxy, Syy) at s."""
    e1, e2, axis = frame
    shape = np.stack(
        [np.stack([params[:, 2], params[:, 3]], -1), np.stack([params[:, 3], params[:, 4]], -1)],
        axis=1,
    )
    lam, vec = np.linalg.eigh(shape)
    vec[:, :, 1] *= np.sign(np.linalg.det(vec))[:, None]  # proper rotation keeps winding
    theta = np.linspace(0.0, 2 * np.pi, RING_POINTS, endpoint=False)
    circle = np.column_stack([np.cos(theta), np.sin(theta)])
    local = params[:, None, :2] + np.einsum("rij,pj->rpi", vec * np.sqrt(lam)[:, None, :], circle)
    rings = origin + s[:, None, None] * axis + local[..., 0:1] * e1 + local[..., 1:2] * e2
    n_rings, p = len(s), RING_POINTS
    caps = origin + s[[0, -1], None] * axis + params[[0, -1], 0:1] * e1 + params[[0, -1], 1:2] * e2
    vertices = np.vstack([rings.reshape(-1, 3), caps])
    ids = np.arange(n_rings * p).reshape(n_rings, p)
    a, b = ids[:-1], np.roll(ids[:-1], -1, axis=1)
    c, d = ids[1:], np.roll(ids[1:], -1, axis=1)
    side = np.vstack(
        [np.column_stack([a.ravel(), b.ravel(), c.ravel()]),
         np.column_stack([b.ravel(), d.ravel(), c.ravel()])]
    )  # fmt: skip
    bottom, top = n_rings * p, n_rings * p + 1
    ring0, ring_n = ids[0], ids[-1]
    bottom_cap = np.column_stack([np.full(p, bottom), np.roll(ring0, -1), ring0])
    top_cap = np.column_stack([np.full(p, top), ring_n, np.roll(ring_n, -1)])
    faces = np.vstack([side, bottom_cap, top_cap])
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


def reconstruct_silhouette(views: Sequence[View], floor_y: float | None) -> SilhouetteResult:
    """Masked station photos -> ankle-to-knee mesh (ARKit world meters) plus artifacts.

    Raises ReconstructionQualityError with a user-facing retake reason.
    """
    usable: list[tuple[View, np.ndarray, np.ndarray]] = []
    for view in views:
        if view.tracking != TRUSTED_TRACKING:
            continue
        leg = leg_component(view.mask)
        if leg is None:
            continue
        normal, cut_off = _centerline_normal(view, leg)
        if cut_off:
            raise _cut_off(view)
        if normal is not None:
            usable.append((view, leg, normal))
    if len(usable) < MIN_VIEWS:
        raise _retake(
            f"Only {len(usable)} of the photos show the leg clearly; at least {MIN_VIEWS} must."
        )

    cameras = np.array([v.camera_to_world[:3, 3] for v, _, _ in usable])
    origin, axis = triangulate_axis(np.array([n for _, _, n in usable]), cameras)
    tilt = float(np.degrees(np.arccos(np.clip(axis[1], -1.0, 1.0))))
    if tilt > MAX_TILT_DEG:
        raise _retake("Keep your shin upright.")
    e1, e2 = _slice_frame(axis)
    frame = (e1, e2, axis)
    rel = cameras - origin
    span = angular_span_deg(np.column_stack([rel @ e1, rel @ e2]), np.zeros(2))
    if span < MIN_SPAN_DEG:
        raise _retake(
            "The photos must go around the front of the leg, from the inner to the outer side."
        )

    s = np.arange(-SWEEP_BELOW_M, SWEEP_ABOVE_M, STEP_M)
    if floor_y is not None:
        s = s[(origin + s[:, None] * axis)[:, 1] >= floor_y + FLOOR_CLEARANCE_M]
    lines = np.full((len(usable), len(s), 2, 3), np.nan)
    for i, (view, leg, _) in enumerate(usable):
        lines[i], on_leg, at_border = _view_lines(view, leg, origin, frame, s)
        if at_border.sum() > CUTOFF_MAX_FRACTION * max(int(on_leg.sum()), 1):
            raise _cut_off(view)

    pivots = np.column_stack([rel @ e1, rel @ e2])
    lines, params, rms, corrections = _refine_views(lines, pivots, s)
    correction_max = float(corrections[:, 0].max())
    shift_max = float(corrections[:, 1].max())
    if correction_max > MAX_VIEW_CORRECTION_DEG or shift_max > MAX_VIEW_SHIFT_M:
        raise _retake(_DISAGREE)
    valid = np.isfinite(params[:, 0])
    if valid.sum() < MIN_PROFILE_BINS:
        raise _retake("The leg could not be traced in the photos.")
    run = _longest_run(valid)
    s_run, p_run, rms_run = s[run], params[run], rms[run]
    ok = np.isfinite(p_run[:, 0])
    for col in range(5):
        p_run[:, col] = np.interp(s_run, s_run[ok], p_run[ok, col])
    p_run = ndimage.median_filter(p_run, size=(SMOOTH_STEPS, 1), mode="nearest")
    p_run = ndimage.uniform_filter1d(p_run, SMOOTH_STEPS, axis=0, mode="nearest")
    det = p_run[:, 2] * p_run[:, 4] - p_run[:, 3] ** 2
    if np.any(det <= 0) or np.any(p_run[:, 2] <= 0):
        raise _retake("The leg could not be traced in the photos.")

    grid = np.arange(s_run[0] + BIN_M / 2, s_run[-1], BIN_M)
    if len(grid) < MIN_PROFILE_BINS:
        raise _retake("The leg could not be traced in the photos.")
    diameter = 2.0 * np.sqrt(np.sqrt(det))
    widths, (ankle, _, knee) = profile_landmarks(np.interp(grid, s_run, diameter))
    seeds, joints_used = _joint_seeds(usable, origin, axis)
    seeded_ankle = _seeded_minimum(widths, grid, seeds["ankle"]) if "ankle" in seeds else None
    seeded_knee = _seeded_minimum(widths, grid, seeds["knee"]) if "knee" in seeds else None
    seeded_ankle = ankle if seeded_ankle is None else seeded_ankle
    seeded_knee = knee if seeded_knee is None else seeded_knee
    if seeded_ankle is not None and seeded_knee is not None:
        length_mm = meters_to_mm(float(grid[seeded_knee] - grid[seeded_ankle]))
        if LEG_LENGTH_MIN_MM <= length_mm <= LEG_LENGTH_MAX_MM:
            ankle, knee = seeded_ankle, seeded_knee
    if ankle is None:
        raise _retake("The ankle could not be found; include the foot and ankle in every photo.")
    if knee is None:
        raise _retake("The knee could not be found; include the knee in every photo.")
    s_ankle, s_knee = float(grid[ankle]), float(grid[knee])

    in_leg = (s_run >= s_ankle) & (s_run <= s_knee) & np.isfinite(rms_run)
    residual_median = float(np.median(rms_run[in_leg])) if in_leg.any() else float("inf")
    if residual_median > MAX_MEDIAN_RESIDUAL_M:
        raise _retake(_DISAGREE)

    ring_s = np.append(np.arange(s_ankle, s_knee, STEP_M), s_knee)
    ring_params = np.column_stack([np.interp(ring_s, s_run, p_run[:, c]) for c in range(5)])
    mesh = _loft(ring_s, ring_params, origin, frame)

    artifacts = {
        "method": METHOD,
        "views_total": len(views),
        "views_used": len(usable),
        "stations_used": [v.station for v, _, _ in usable],
        "azimuth_span_deg": span,
        "axis_tilt_deg": tilt,
        "axis_point_m": [float(x) for x in origin],
        "axis_direction": [float(x) for x in axis],
        "residual_median_m": residual_median,
        "view_correction_max_deg": correction_max,
        "view_shift_max_m": shift_max,
        "residual_p90_m": float(np.percentile(rms_run[in_leg], 90)),
        "slices": len(ring_s),
        "leg_length_m": s_knee - s_ankle,
        "floor_used": floor_y is not None,
        "joints_used": joints_used,
        "ankle_found": True,
        "knee_found": True,
    }
    return SilhouetteResult(mesh=mesh, artifacts=artifacts)
