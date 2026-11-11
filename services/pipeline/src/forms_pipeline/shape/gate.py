"""The fit-risk gate and the best next action (docs/ESTIMATOR-V1.md 5; plan 4.6).

r = max over fit-critical keys of 2 * sigma / T, excluding typed pass-through
keys (user-attested, not gated by sigma). Never raises: anything that cannot be
evaluated is a "fail", which the wiring turns into GateViolationError.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal

import numpy as np

from forms_pipeline.contract import MEASUREMENT_KEYS
from forms_pipeline.shape.fuse import (
    Posterior,
    condition_cov,
    fuse,
    reported_covariance,
    value_sigmas_mm,
)
from forms_pipeline.shape.model import (
    FIT_CRITICAL_KEYS,
    GRID_T,
    LEG_LENGTH_KEY,
    depths_mm,
    project,
    state_index,
    widths_mm,
)
from forms_pipeline.shape.observe import (
    MANUAL_KEYS,
    OBSERVABLE_K,
    Observations,
    SectionProfile,
    observations_from_manual,
    observations_from_profile,
    tape_sigma_mm,
)
from forms_pipeline.shape.prior import STATURE_COVARIATE, Prior

Verdict = Literal["none", "optional", "required", "fail"]

# Bands on r (plan 4.6): r <= 0.6 none, <= 1.0 optional, <= 2.0 required, else fail.
BAND_NONE = 0.6
BAND_OPTIONAL = 1.0
BAND_REQUIRED = 2.0

# TODO(liam): provisional tolerances (plan 4.6 item 2, section 15 decision 7); one set
# for now, per product later (worst over purchasable products).
TOLERANCE_LEG_LENGTH_MM = 15.0
TOLERANCE_SLICE_MM = 6.0
DEFAULT_TOLERANCES: Mapping[str, float] = MappingProxyType(
    {
        key: TOLERANCE_LEG_LENGTH_MM if key == LEG_LENGTH_KEY else TOLERANCE_SLICE_MM
        for key in FIT_CRITICAL_KEYS
    }
)

# Ratios and variances are compared after rounding so float noise cannot break a tie.
_RATIO_DECIMALS = 9
_VARIANCE_DECIMALS = 6


@dataclass(frozen=True)
class FitAction:
    kind: Literal["tape", "stature"]
    key: str | None = None

    def to_json(self) -> dict[str, str]:
        if self.kind == "stature":
            return {"kind": "stature"}
        return {"kind": "tape", "key": str(self.key)}


@dataclass(frozen=True)
class GateResult:
    verdict: Verdict
    worst_ratio: float
    worst_key: str | None
    action: FitAction | None
    sigma_mm: Mapping[str, float]


def verdict_for_ratio(r: float) -> Verdict:
    if not math.isfinite(r) or r < 0:
        return "fail"
    if r <= BAND_NONE:
        return "none"
    if r <= BAND_OPTIONAL:
        return "optional"
    if r <= BAND_REQUIRED:
        return "required"
    return "fail"


def worst_ratio(
    sigma_mm: Mapping[str, float], excluded: frozenset[str], tolerances: Mapping[str, float]
) -> tuple[float, str | None]:
    """(r, worst key) over fit-critical keys not excluded; (0, None) when none remain.

    A missing or invalid tolerance or sigma makes r infinite (a fail), never a pass.
    """
    worst, worst_key = 0.0, None
    for key in FIT_CRITICAL_KEYS:
        if key in excluded:
            continue
        tol, sigma = tolerances.get(key), sigma_mm.get(key)
        valid = (
            isinstance(tol, int | float)
            and isinstance(sigma, int | float)
            and math.isfinite(tol)
            and tol > 0
            and math.isfinite(sigma)
            and sigma >= 0
        )
        if not valid:
            return math.inf, key
        r = 2.0 * float(sigma) / float(tol)
        if r > worst or worst_key is None:
            worst, worst_key = r, key
    if worst_key is not None and worst == 0.0:
        return 0.0, None
    return worst, worst_key


def _fit_variance(sigma_mm: Mapping[str, float]) -> float:
    return float(sum(sigma_mm[k] ** 2 for k in FIT_CRITICAL_KEYS))


def _candidates(posterior: Posterior) -> list[tuple[int, FitAction]]:
    out = [
        (MEASUREMENT_KEYS.index(key), FitAction("tape", key))
        for key in FIT_CRITICAL_KEYS
        if key not in posterior.pass_through
    ]
    if posterior.prior.has_covariate(STATURE_COVARIATE) and posterior.stature_mm is None:
        out.append((len(MEASUREMENT_KEYS), FitAction("stature")))
    return out


def _after_action(posterior: Posterior, action: FitAction) -> tuple[np.ndarray, frozenset[str]]:
    """Reported covariance and excluded keys if this action were taken (exact: cov ignores y)."""
    excluded = frozenset(posterior.pass_through)
    if action.kind == "stature":
        stature = next(c for c in posterior.prior.covariates if c.name == STATURE_COVARIATE)
        # Any valid stature will do: the covariance does not depend on its value.
        _mean, prior_cov = posterior.prior.moments(stature.reference)
        return reported_covariance(prior_cov, posterior.observations), excluded
    key = str(action.key)
    i = state_index(key)
    value = math.exp(float(posterior.mean[i]))
    noise = np.array([[(tape_sigma_mm(key) / value) ** 2]])
    cov = condition_cov(np.asarray(posterior.cov), np.array([i], dtype=np.intp), noise)
    return cov, excluded | {key}


def action_outcomes(
    posterior: Posterior, tolerances: Mapping[str, float]
) -> list[tuple[FitAction, float, float, int]]:
    """(action, resulting r, resulting total fit-critical variance mm^2, order) per candidate."""
    rows = []
    for order, action in _candidates(posterior):
        cov, excluded = _after_action(posterior, action)
        sigma = value_sigmas_mm(posterior, cov)
        r, _key = worst_ratio(sigma, excluded, tolerances)
        rows.append((action, r, _fit_variance(sigma), order))
    return rows


def best_action(posterior: Posterior, tolerances: Mapping[str, float]) -> FitAction | None:
    """Argmin of the resulting r; ties by total fit-critical variance, then key order."""
    rows = action_outcomes(posterior, tolerances)
    if not rows:
        return None
    best = min(
        rows,
        key=lambda row: (
            round(row[1], _RATIO_DECIMALS) if math.isfinite(row[1]) else math.inf,
            round(row[2], _VARIANCE_DECIMALS),
            row[3],
        ),
    )
    return best[0]


def _fail() -> GateResult:
    return GateResult("fail", math.inf, None, None, MappingProxyType({}))


def evaluate(
    posterior: Posterior, tolerances: Mapping[str, float] = DEFAULT_TOLERANCES
) -> GateResult:
    """Verdict, worst ratio and key, the one best action, and every key's sigma."""
    try:
        sigma = value_sigmas_mm(posterior)
        r, worst_key = worst_ratio(sigma, frozenset(posterior.pass_through), tolerances)
        verdict = verdict_for_ratio(r)
        action = None if verdict == "none" else best_action(posterior, tolerances)
        return GateResult(verdict, r, worst_key, action, MappingProxyType(sigma))
    except Exception:  # the gate never raises; anything unexpected is a fail
        return _fail()


@dataclass(frozen=True)
class FeasibilityRow:
    source_mix: str
    verdict: Verdict
    worst_ratio: float
    worst_key: str | None


def _nominal_profile(x: np.ndarray, source: str, span: float | None) -> SectionProfile:
    w, d = widths_mm(x), depths_mm(x)
    return SectionProfile(
        source=source,  # type: ignore[arg-type]
        leg_length_mm=float(np.exp(x[0])),
        t=tuple(float(GRID_T[k]) for k in OBSERVABLE_K),
        width_mm=tuple(float(w[k]) for k in OBSERVABLE_K),
        depth_mm=tuple(float(d[k]) for k in OBSERVABLE_K),
        azimuth_span_deg=span,
    )


def feasibility_table(
    prior: Prior, tolerances: Mapping[str, float] = DEFAULT_TOLERANCES
) -> tuple[FeasibilityRow, ...]:
    """Predicted verdict per source mix on the prior-mean leg (plan 4.6 item 3).

    Provisional: uses the provisional noise and tolerances; not a ship check.
    """
    x = np.asarray(prior.mean)
    values = project(x)
    mixes: Sequence[tuple[str, list[Observations]]] = (
        (
            "full silhouette sweep (span 180)",
            [observations_from_profile(_nominal_profile(x, "silhouette", 180.0))],
        ),
        (
            "short sweep (span 90)",
            [observations_from_profile(_nominal_profile(x, "silhouette", 90.0))],
        ),
        ("mesh", [observations_from_profile(_nominal_profile(x, "mesh", None))]),
        (
            "manual only",
            [observations_from_manual({k: values[k] for k in MANUAL_KEYS}, adjusted=False)],
        ),
        ("prior only", []),
    )
    rows = []
    for name, obs in mixes:
        result = evaluate(fuse(prior, obs), tolerances)
        rows.append(FeasibilityRow(name, result.verdict, result.worst_ratio, result.worst_key))
    return tuple(rows)
