"""Observations of the leg state from each source (docs/ESTIMATOR-V1.md 4).

Every v1 observation reads one state entry directly in log space,
y = ln(v) = x[i] + e. Evidence comes from mesh sections (extraction's own
frame and slicer), never from silhouette artifacts. Noise is per source and
provisional.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal

import numpy as np
import trimesh

from forms_pipeline.contract import SCHEMA
from forms_pipeline.extraction.measure import MeasurementError, oriented_leg_mesh, slice_dims
from forms_pipeline.shape.errors import EstimatorError
from forms_pipeline.shape.model import (
    FIT_CRITICAL_KEYS,
    GRID_T,
    IDX_L,
    LEG_LENGTH_KEY,
    K,
    idx_d,
    idx_w,
    state_index,
)

SourceKind = Literal["mesh", "silhouette", "scale_free"]
ObservationSource = Literal["mesh", "silhouette", "scale_free", "manual", "adjusted"]
SCAN_SOURCES: frozenset[str] = frozenset({"mesh", "silhouette", "scale_free"})
PASS_THROUGH_SOURCES: frozenset[str] = frozenset({"manual", "adjusted"})

# Heights a capture may observe: GRID_T[1:20], t = 0.05..0.95 (ESTIMATOR-V1 4).
OBSERVABLE_K: tuple[int, ...] = tuple(range(1, K - 1))
GRID_MATCH_TOLERANCE = 1e-9
OBS_KERNEL_LENGTH_T = 0.25
# Typed values are conditioned this tightly so the projection reproduces them.
PASS_THROUGH_EFFECTIVE_MM = 0.05
# Sanity bound only; the schema's plausibility gates run on the final values.
MAX_EXTENT_MM = 10_000.0
MANUAL_KEYS: tuple[str, ...] = FIT_CRITICAL_KEYS


@dataclass(frozen=True)
class NoiseModel:
    width_mm: float
    depth_mm: float
    length_mm: float
    scale_log_sigma: float | None
    rho_obs: float


# TODO(liam): provisional noise, calibrate from Phase 0 tape ground truth (plan 4.4).
NOISE: Mapping[str, NoiseModel] = MappingProxyType(
    {
        "mesh": NoiseModel(1.5, 2.0, 5.0, 0.02, 0.5),
        "silhouette": NoiseModel(2.0, 3.0, 5.0, 0.015, 0.5),
        "scale_free": NoiseModel(2.0, 3.0, 5.0, 1.0, 0.5),
        "manual": NoiseModel(3.0, 3.0, 5.0, None, 0.0),
    }
)
# Silhouette depth sigma grows as the swept arc narrows: 3.0 x clip(1 + (150 - span)/30, 1, 2).
SPAN_FULL_DEG = 150.0
SPAN_SLOPE_DEG = 30.0
SPAN_FACTOR_MAX = 2.0


@dataclass(frozen=True)
class SectionProfile:
    """One capture's leg sections at grid heights, mm, in extraction's frame."""

    source: SourceKind
    leg_length_mm: float
    t: tuple[float, ...]  # subset of GRID_T[1:20]; heights with no section are absent
    width_mm: tuple[float, ...]  # OW-definition extent at each t
    depth_mm: tuple[float, ...]  # OD-definition extent at each t
    azimuth_span_deg: float | None = None  # None means worst-case sigma


@dataclass(frozen=True, eq=False)
class Observations:
    """Rows y[r] = x[index[r]] + e, e ~ N(0, noise_cov) for the mean.

    `report_cov` is the noise used for reported uncertainty; it differs from
    `noise_cov` only for typed pass-through values (tape sigma vs the tight
    conditioning noise). `pass_through` holds the typed values, mm.
    """

    source: ObservationSource
    index: np.ndarray
    y: np.ndarray
    noise_cov: np.ndarray
    report_cov: np.ndarray
    pass_through: Mapping[str, float]

    @property
    def rows(self) -> int:
        return int(self.index.shape[0])


def depth_sigma_mm(source: SourceKind, azimuth_span_deg: float | None) -> float:
    base = NOISE[source].depth_mm
    if source == "mesh":
        return base
    if azimuth_span_deg is None:
        return base * SPAN_FACTOR_MAX
    factor = 1.0 + (SPAN_FULL_DEG - azimuth_span_deg) / SPAN_SLOPE_DEG
    return base * min(max(factor, 1.0), SPAN_FACTOR_MAX)


def _grid_k(t: float) -> int:
    k = int(round(t * (K - 1)))
    if k not in OBSERVABLE_K or abs(GRID_T[k] - t) > GRID_MATCH_TOLERANCE:
        raise EstimatorError("bad_profile")
    return k


def _positive_mm(v: object) -> float:
    if isinstance(v, bool) or not isinstance(v, int | float):
        raise EstimatorError("bad_profile")
    f = float(v)
    if not math.isfinite(f) or not 0.0 < f <= MAX_EXTENT_MM:
        raise EstimatorError("bad_profile")
    return f


def _freeze(*arrays: np.ndarray) -> None:
    for a in arrays:
        a.setflags(write=False)


def observations_from_profile(profile: SectionProfile) -> Observations:
    """Rows for L and each observed (w, d), with correlated per-capture noise."""
    if profile.source not in NOISE or profile.source not in SCAN_SOURCES:
        raise EstimatorError("bad_profile")
    n = len(profile.t)
    if len(profile.width_mm) != n or len(profile.depth_mm) != n:
        raise EstimatorError("bad_profile")
    span = profile.azimuth_span_deg
    if span is not None:
        if isinstance(span, bool) or not isinstance(span, int | float):
            raise EstimatorError("bad_profile")
        if not math.isfinite(span) or not 0.0 <= span <= 360.0:
            raise EstimatorError("bad_profile")
    ks = [_grid_k(float(t)) for t in profile.t]
    if len(set(ks)) != n:
        raise EstimatorError("bad_profile")
    length = _positive_mm(profile.leg_length_mm)
    w = np.array([_positive_mm(v) for v in profile.width_mm], dtype=np.float64)
    d = np.array([_positive_mm(v) for v in profile.depth_mm], dtype=np.float64)

    noise = NOISE[profile.source]
    sigma_d = depth_sigma_mm(profile.source, span)
    t_obs = GRID_T[ks]
    k_obs = np.exp(-((t_obs[:, None] - t_obs[None, :]) ** 2) / (2.0 * OBS_KERNEL_LENGTH_T**2))
    corr = (1.0 - noise.rho_obs) * np.eye(n) + noise.rho_obs * k_obs

    def block(sigma_log: np.ndarray) -> np.ndarray:
        return np.diag(sigma_log) @ corr @ np.diag(sigma_log)

    m = 1 + 2 * n
    cov = np.zeros((m, m))
    cov[0, 0] = (noise.length_mm / length) ** 2
    cov[1 : 1 + n, 1 : 1 + n] = block(noise.width_mm / w)
    cov[1 + n :, 1 + n :] = block(sigma_d / d)
    # Per-capture log-scale nuisance, shared by every row including L, marginalized exactly.
    scale = noise.scale_log_sigma or 0.0
    cov += scale**2 * np.ones((m, m))
    cov = 0.5 * (cov + cov.T)

    index = np.array([IDX_L, *(idx_w(k) for k in ks), *(idx_d(k) for k in ks)], dtype=np.intp)
    y = np.concatenate([[math.log(length)], np.log(w), np.log(d)])
    _freeze(index, y, cov)
    return Observations(
        source=profile.source,
        index=index,
        y=y,
        noise_cov=cov,
        report_cov=cov,
        pass_through=MappingProxyType({}),
    )


def section_profile_from_mesh(
    mesh: trimesh.Trimesh, source: SourceKind, azimuth_span_deg: float | None = None
) -> SectionProfile:
    """Sections at t = 0.05..0.95 in extraction's frame; unmeasurable heights are dropped."""
    if source not in SCAN_SOURCES:
        raise EstimatorError("bad_profile")
    mesh_rot, leg_length, _needs_scale_confirmation = oriented_leg_mesh(mesh)
    ts: list[float] = []
    widths: list[float] = []
    depths: list[float] = []
    for k in OBSERVABLE_K:
        t = float(GRID_T[k])
        try:
            dims = slice_dims(mesh_rot, z=t * leg_length)
        except MeasurementError:
            continue
        ow, od = dims["OW"], dims["OD"]
        if not (math.isfinite(ow) and math.isfinite(od) and ow > 0 and od > 0):
            continue
        ts.append(t)
        widths.append(ow)
        depths.append(od)
    if not ts:
        raise EstimatorError("no_sections")
    return SectionProfile(
        source=source,
        leg_length_mm=leg_length,
        t=tuple(ts),
        width_mm=tuple(widths),
        depth_mm=tuple(depths),
        azimuth_span_deg=azimuth_span_deg,
    )


def tape_sigma_mm(key: str) -> float:
    noise = NOISE["manual"]
    if key == LEG_LENGTH_KEY:
        return noise.length_mm
    return noise.width_mm if key.endswith("_OW") else noise.depth_mm


def observations_from_manual(values_mm: Mapping[str, float], adjusted: bool) -> Observations:
    """Typed tape values (any non-empty subset of the 9 manual keys), passed through."""
    if not isinstance(values_mm, Mapping) or not values_mm:
        raise EstimatorError("bad_manual_keys")
    if not set(values_mm) <= set(MANUAL_KEYS):
        raise EstimatorError("bad_manual_keys")
    keys = [k for k in MANUAL_KEYS if k in values_mm]
    vals: list[float] = []
    for key in keys:
        v = values_mm[key]
        if isinstance(v, bool) or not isinstance(v, int | float) or not math.isfinite(v):
            raise EstimatorError("bad_manual_value")
        spec = SCHEMA["properties"][key]
        if not spec["minimum"] <= v <= spec["maximum"]:
            raise EstimatorError("bad_manual_value")
        vals.append(float(v))
    v_arr = np.array(vals)
    index = np.array([state_index(k) for k in keys], dtype=np.intp)
    y = np.log(v_arr)
    noise_cov = np.diag((PASS_THROUGH_EFFECTIVE_MM / v_arr) ** 2)
    report_cov = np.diag((np.array([tape_sigma_mm(k) for k in keys]) / v_arr) ** 2)
    _freeze(index, y, noise_cov, report_cov)
    return Observations(
        source="adjusted" if adjusted else "manual",
        index=index,
        y=y,
        noise_cov=noise_cov,
        report_cov=report_cov,
        pass_through=MappingProxyType(dict(zip(keys, vals, strict=True))),
    )
