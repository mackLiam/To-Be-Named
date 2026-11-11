"""A seated leg with the knee bent: the truth shin of test_silhouette plus a hinged thigh.

The knee is modeled as a hinge about a mediolateral axis through the center of the
true cross-section at JOINT_H:
- below JOINT_H: the truth shin of test_silhouette, unchanged;
- above it: the truth profile from JOINT_H up (thigh semi-axes 60 x 62 mm at TOP_H, 1.4
  times the 43 mm knee semi-axis), held constant beyond TOP_H to THIGH_LENGTH_M, then
  rotated backward about the axis by the flexion angle;
- the region the section at JOINT_H sweeps through on its way there (the condyles).
At flexion 0 this is the truth leg with its thigh in line, run on past TOP_H.
JOINT_H sits 25 mm above the dip below the kneecap (KNEE_H): roughly the femoral
condyle center above the joint line. Masks are ray cast from test_silhouette's five
station cameras, so only the scene and the resolution differ.
"""

from __future__ import annotations

import functools

import numpy as np
from scipy import ndimage
from test_silhouette import (
    ELLIPSE_ANGLE_RAD,
    KNEE_H,
    TOP_H,
    leg_base,
    leg_rotation,
    section,
    station_cameras,
)

from forms_pipeline.reconstruct.silhouette import View, project, ray_directions

# Half the station photo's resolution: the size v3 uploads masks at (SCAN-V3-PLAN.md 5.4),
# and a quarter of the rays, which dominate this module's cost.
WIDTH, HEIGHT = 960, 720
INTRINSICS = (725.0, 725.0, 479.5, 359.5)
JOINT_H = KNEE_H + 0.025
THIGH_LENGTH_M = 0.35  # from the joint axis to the thigh's far end
# A ray grazing a 45 mm radius solid holds a 4 mm chord from 0.04 mm inside its edge,
# a tenth of a pixel at the station distance: finer steps change no mask edge.
RAY_STEP_M = 0.004
# Pixel steps of the refinement: each level casts rays only near the previous level's edge.
LEVELS_PX = (16, 4, 1)
_TABLE_STEP_M = 0.0002
_CHUNK = 4000
# Leg-local bounds of the shin and of the unrotated upper part (x, y, z), meters.
_SHIN_BOX = np.array([[-0.12, 0.0, -0.12], [0.12, JOINT_H, 0.20]])
_UPPER_BOX = np.array([[-0.12, JOINT_H, -0.12], [0.12, JOINT_H + THIGH_LENGTH_M, 0.12]])
_SWEPT_MARGIN_M = 0.07  # beyond the largest joint-section radius


def _joint_zc() -> float:
    return float(section(np.array([JOINT_H]))[3][0])


@functools.lru_cache
def _section_table() -> tuple[np.ndarray, ...]:
    """section() every _TABLE_STEP_M on [0, TOP_H]: the PCHIP call dominates ray casting."""
    hs = np.arange(0.0, TOP_H + _TABLE_STEP_M, _TABLE_STEP_M)
    return section(hs)


def _in_section(x: np.ndarray, h: np.ndarray, z: np.ndarray) -> np.ndarray:
    """Is (x, z) inside the truth cross-section at height h (clipped to [0, TOP_H])?"""
    table = _section_table()
    idx = np.clip(np.rint(h / _TABLE_STEP_M).astype(np.int64), 0, len(table[0]) - 1)
    a, b, cx, cz = (col[idx] for col in table)
    c, s = np.cos(ELLIPSE_ANGLE_RAD), np.sin(ELLIPSE_ANGLE_RAD)
    dx, dz = x - cx, z - cz
    lx, lz = c * dx + s * dz, -s * dx + c * dz
    return (lx / a) ** 2 + (lz / b) ** 2 <= 1.0


def inside_bent(p: np.ndarray, flexion_deg: float) -> np.ndarray:
    """Leg-local points (..., 3) inside the solid with the knee bent by flexion_deg."""
    phi = np.radians(flexion_deg)
    cos_p, sin_p = np.cos(phi), np.sin(phi)
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    zj = _joint_zc()
    inside = (y >= 0.0) & (y <= JOINT_H) & _in_section(x, y, z)
    # Upper part: undo the hinge (+y turns toward -z by phi) and test the in-line leg.
    dy, dz = y - JOINT_H, z - zj
    qy = dy * cos_p - dz * sin_p
    qz = dy * sin_p + dz * cos_p
    inside |= (qy >= 0.0) & (qy <= THIGH_LENGTH_M) & _in_section(x, JOINT_H + qy, zj + qz)
    # Swept joint section: its front half turns up through 0..phi, its back half down,
    # each point keeping its distance r from the axis.
    r = np.hypot(dy, dz)
    jh = np.full_like(x, JOINT_H)
    front = (dy >= 0.0) & (dz * sin_p - dy * cos_p >= 0.0)
    back = (dy <= 0.0) & (dy * cos_p - dz * sin_p >= 0.0)
    inside |= front & _in_section(x, jh, zj + r)
    inside |= back & _in_section(x, jh, zj - r)
    return inside


def _corners(box: np.ndarray) -> np.ndarray:
    return np.array([[x, y, z] for x in box[:, 0] for y in box[:, 1] for z in box[:, 2]])


def _box(flexion_deg: float) -> np.ndarray:
    """Leg-local axis-aligned bounds of the bent solid."""
    phi = np.radians(flexion_deg)
    corners = _corners(_UPPER_BOX)
    zj = _joint_zc()
    dy, dz = corners[:, 1] - JOINT_H, corners[:, 2] - zj
    turned = corners.copy()
    turned[:, 1] = JOINT_H + dy * np.cos(phi) + dz * np.sin(phi)
    turned[:, 2] = zj - dy * np.sin(phi) + dz * np.cos(phi)
    pts = np.vstack([_SHIN_BOX, turned])
    return np.array([pts.min(0) - _SWEPT_MARGIN_M, pts.max(0) + _SWEPT_MARGIN_M])


def _inside_rays(
    c2w: np.ndarray, flexion_deg: float, tilt_deg: float, pix: np.ndarray
) -> np.ndarray:
    """Does each pixel's ray pass through the bent solid?"""
    rot, base = leg_rotation(tilt_deg), leg_base()
    origin = rot.T @ (c2w[:3, 3] - base)
    lo, hi = _box(flexion_deg)
    n_samples = int(np.ceil(np.linalg.norm(hi - lo) / RAY_STEP_M))
    out = np.zeros(len(pix), dtype=bool)
    for start in range(0, len(pix), _CHUNK):
        d = ray_directions(c2w, INTRINSICS, pix[start : start + _CHUNK]) @ rot
        with np.errstate(divide="ignore", invalid="ignore"):
            t_a, t_b = (lo - origin) / d, (hi - origin) / d
        t0 = np.nanmax(np.minimum(t_a, t_b), axis=1)
        t1 = np.nanmin(np.maximum(t_a, t_b), axis=1)
        hit = np.flatnonzero(t1 > np.maximum(t0, 0.0))
        ts = t0[hit, None] + (t1 - t0)[hit, None] * np.linspace(0, 1, n_samples)[None]
        p = origin + ts[..., None] * d[hit, None, :]
        out[start + hit] = inside_bent(p, flexion_deg).any(axis=1)
    return out


def render_bent_mask(c2w: np.ndarray, flexion_deg: float, tilt_deg: float = 0.0) -> np.ndarray:
    """Ray-cast the bent leg, refining LEVELS_PX: each level casts only the rays in or
    next to a cell whose corners disagree at the level before; the rest inherit."""
    rot, base = leg_rotation(tilt_deg), leg_base()
    uv, depth = project(c2w, INTRINSICS, base + _corners(_box(flexion_deg)) @ rot.T)
    assert np.all(depth > 0), "the camera is inside the scene bounds"
    step0 = LEVELS_PX[0]
    ulo = np.clip(np.floor(uv.min(0)), 0, None).astype(int)
    uhi = np.minimum(np.ceil(uv.max(0)), [WIDTH - 1, HEIGHT - 1]).astype(int)
    extent = -(-(uhi - ulo) // step0) * step0  # whole coarse cells
    value = None
    prev = step0
    for step in LEVELS_PX:
        n = extent // step + 1
        gu, gv = np.meshgrid(ulo[0] + step * np.arange(n[0]), ulo[1] + step * np.arange(n[1]))
        if value is None:
            cast = np.ones(gu.shape, dtype=bool)
            new = np.zeros(gu.shape, dtype=bool)
        else:
            quad = np.stack([value[:-1, :-1], value[1:, :-1], value[:-1, 1:], value[1:, 1:]])
            mixed = ndimage.binary_dilation(quad.any(0) & ~quad.all(0), iterations=1)
            ratio = prev // step
            ci = np.minimum(np.arange(n[1]) // ratio, quad.shape[1] - 1)
            cj = np.minimum(np.arange(n[0]) // ratio, quad.shape[2] - 1)
            new = quad.all(0)[np.ix_(ci, cj)]
            cast = mixed[np.ix_(ci, cj)]
        pix = np.column_stack([gu[cast], gv[cast]]).astype(float)
        new[cast] = _inside_rays(c2w, flexion_deg, tilt_deg, pix)
        value, prev = new, step
    mask = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    rows = min(value.shape[0], HEIGHT - ulo[1])
    cols = min(value.shape[1], WIDTH - ulo[0])
    mask[ulo[1] : ulo[1] + rows, ulo[0] : ulo[0] + cols] = np.where(value[:rows, :cols], 255, 0)
    return mask


@functools.lru_cache
def bent_views(flexion_deg: float, tilt_deg: float = 0.0) -> tuple[View, ...]:
    """The five station views of the bent leg. Cached: rendering dominates."""
    return tuple(
        View(
            station=name,
            mask=render_bent_mask(c2w, flexion_deg, tilt_deg),
            camera_to_world=c2w,
            intrinsics=INTRINSICS,
        )
        for name, c2w in station_cameras(tilt_deg).items()
    )
