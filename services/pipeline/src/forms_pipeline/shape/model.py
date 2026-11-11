"""The v1 leg state, its contours, and the 25-value projection (docs/ESTIMATOR-V1.md 3, 5).

State (n = 43): index 0 = log_L; 1..21 = log_w[k] (OW, full mediolateral
width); 22..42 = log_d[k] (OD, full anterior-posterior depth); logs of mm, on
GRID_T = k/20. The v1 section is an ellipse (w, d) centred on the leg axis;
a(t), m(t) and shape harmonics are deferred, so the inner keys are the
symmetric split ISW = ICW = OW/2, ISD = ICD = OD (what manualMeasurements.ts
does today). Outputs are schema 1.1.0 leg measurements, never crest-relative
values (cad/profile.py is the only converter).
"""

from __future__ import annotations

from collections.abc import Mapping

import numpy as np

from forms_pipeline.contract import MEASUREMENT_KEYS, ContractError
from forms_pipeline.extraction.measure import SLICE_FRACTIONS

# Versions observe.py noise, the projection and legmodel output (ESTIMATOR-V1 4).
ESTIMATOR_VERSION = "0.1.0"

K = 21
GRID_T: np.ndarray = np.arange(K, dtype=np.float64) / (K - 1)
GRID_T.setflags(write=False)
N_STATE = 1 + 2 * K
IDX_L = 0
COMPONENTS: tuple[str, ...] = ("log_L", "log_w", "log_d")
RING_POINTS = 48

_DIMS = ("ISW", "ISD", "ICW", "ICD", "OW", "OD")


def _split(key: str) -> tuple[str, str]:
    prefix, _, suffix = key.rpartition("_")
    return prefix, suffix


SLICES: tuple[str, ...] = tuple(
    dict.fromkeys(_split(key)[0] for key in MEASUREMENT_KEYS if _split(key)[1] in _DIMS)
)
_PASSTHROUGH = tuple(key for key in MEASUREMENT_KEYS if _split(key)[1] not in _DIMS)
if len(_PASSTHROUGH) != 1 or set(SLICES) != set(SLICE_FRACTIONS):
    raise ContractError("measurement schema no longer matches the shape/ state layout")
(LEG_LENGTH_KEY,) = _PASSTHROUGH


def _grid_index(fraction: float) -> int:
    k = int(round(fraction * (K - 1)))
    if GRID_T[k] != fraction:
        raise ContractError("slice fractions are not on the shape/ grid")
    return k


# Slice heights come from extraction's SLICE_FRACTIONS (S1..S4 = k 4, 8, 12, 16).
SLICE_K: dict[str, int] = {s: _grid_index(SLICE_FRACTIONS[s]) for s in SLICES}

# Fit-critical keys: Leg_Length plus every slice's OW and OD (ESTIMATOR-V1 5).
FIT_CRITICAL_KEYS: tuple[str, ...] = tuple(
    k for k in MEASUREMENT_KEYS if k == LEG_LENGTH_KEY or _split(k)[1] in ("OW", "OD")
)
INNER_KEYS: tuple[str, ...] = tuple(k for k in MEASUREMENT_KEYS if k not in FIT_CRITICAL_KEYS)


def idx_w(k: int) -> int:
    return 1 + k


def idx_d(k: int) -> int:
    return 1 + K + k


def state_index(key: str) -> int:
    """State index observed directly by a fit-critical key."""
    if key == LEG_LENGTH_KEY:
        return IDX_L
    prefix, dim = _split(key)
    if key in FIT_CRITICAL_KEYS:
        k = SLICE_K[prefix]
        return idx_w(k) if dim == "OW" else idx_d(k)
    raise KeyError(key)


def key_for_index(i: int) -> str | None:
    """The fit-critical key at state index i, or None for grid heights between slices."""
    for key in FIT_CRITICAL_KEYS:
        if state_index(key) == i:
            return key
    return None


def label(i: int) -> tuple[str, int | None]:
    """(component, k) for state index i; k is None for log_L."""
    if i == IDX_L:
        return "log_L", None
    if 1 <= i <= K:
        return "log_w", i - 1
    if K < i < N_STATE:
        return "log_d", i - 1 - K
    raise IndexError(i)


def index_of(component: str, k: int | None = None) -> int:
    """Inverse of `label`."""
    if component == "log_L" and k is None:
        return IDX_L
    if k is not None and 0 <= k < K:
        if component == "log_w":
            return idx_w(k)
        if component == "log_d":
            return idx_d(k)
    raise KeyError(component)


def state_from_mm(leg_length_mm: float, widths_mm: np.ndarray, depths_mm: np.ndarray) -> np.ndarray:
    """The 43-number state from a leg length and K widths and depths (mm)."""
    w = np.asarray(widths_mm, dtype=np.float64)
    d = np.asarray(depths_mm, dtype=np.float64)
    if w.shape != (K,) or d.shape != (K,):
        raise ValueError("widths and depths must have one entry per grid height")
    return np.concatenate([[np.log(leg_length_mm)], np.log(w), np.log(d)])


def widths_mm(x: np.ndarray) -> np.ndarray:
    return np.exp(np.asarray(x)[1 : 1 + K])


def depths_mm(x: np.ndarray) -> np.ndarray:
    return np.exp(np.asarray(x)[1 + K : N_STATE])


def project(x: np.ndarray) -> dict[str, float]:
    """The 25 leg measurements (mm, MEASUREMENT_KEYS order) of state x (f of the mean)."""
    x = np.asarray(x, dtype=np.float64)
    fit = {key: float(np.exp(x[state_index(key)])) for key in FIT_CRITICAL_KEYS}
    return complete_values(fit)


def complete_values(fit_values: Mapping[str, float]) -> dict[str, float]:
    """All 25 values from the 9 fit-critical ones, by the v1 symmetric inner split."""
    out: dict[str, float] = {}
    for key in MEASUREMENT_KEYS:
        if key in FIT_CRITICAL_KEYS:
            out[key] = float(fit_values[key])
            continue
        prefix, dim = _split(key)
        if dim in ("ISW", "ICW"):
            out[key] = float(fit_values[f"{prefix}_OW"]) / 2.0
        else:
            out[key] = float(fit_values[f"{prefix}_OD"])
    return out


def projection_jacobian(x: np.ndarray) -> np.ndarray:
    """d(project(x)) / dx, shape (25, 43), rows in MEASUREMENT_KEYS order."""
    values = project(x)
    jac = np.zeros((len(MEASUREMENT_KEYS), N_STATE))
    for row, key in enumerate(MEASUREMENT_KEYS):
        if key in FIT_CRITICAL_KEYS:
            source = key
        else:
            prefix, dim = _split(key)
            source = f"{prefix}_OW" if dim in ("ISW", "ICW") else f"{prefix}_OD"
        jac[row, state_index(source)] = values[key]
    return jac


def contour(width_mm: float, depth_mm: float, n: int = RING_POINTS) -> np.ndarray:
    """The v1 section: an (n, 2) ellipse, semi-axes w/2 on x and d/2 on y, counter-clockwise.

    Point i sits at angle 2*pi*i/n, so x-extent is w and y-extent is d exactly
    whenever n is a multiple of 4. The polygon is implicitly closed (last point
    joins the first).
    """
    if n < 4 or n % 4:
        raise ValueError("contour point count must be a positive multiple of four")
    theta = 2.0 * np.pi * np.arange(n) / n
    pts = np.column_stack([0.5 * width_mm * np.cos(theta), 0.5 * depth_mm * np.sin(theta)])
    # cos and sin at the quarter turns are not exactly 0 and +-1 in floating point.
    q = n // 4
    pts[0] = (0.5 * width_mm, 0.0)
    pts[q] = (0.0, 0.5 * depth_mm)
    pts[2 * q] = (-0.5 * width_mm, 0.0)
    pts[3 * q] = (0.0, -0.5 * depth_mm)
    return pts


def signed_area(points: np.ndarray) -> float:
    """Shoelace signed area; > 0 means counter-clockwise seen from +z."""
    p = np.asarray(points, dtype=np.float64)
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


def ring_extents(points: np.ndarray) -> tuple[float, float]:
    """(x-extent, y-extent) of a ring."""
    p = np.asarray(points, dtype=np.float64)
    return float(np.ptp(p[:, 0])), float(np.ptp(p[:, 1]))
