"""Closed-form Gaussian fusion of the prior and every observation (docs/ESTIMATOR-V1.md 5).

Cholesky solves and the Joseph-form covariance update; no iteration. The mean
is conditioned on each source's `noise_cov`; the reported covariance on its
`report_cov` (they differ only for typed pass-through values). Covariance never
depends on y, which is what lets gate.py evaluate actions exactly.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from types import MappingProxyType

import numpy as np
from scipy.linalg import LinAlgError, cho_factor, cho_solve

from forms_pipeline.contract import MEASUREMENT_KEYS
from forms_pipeline.shape.errors import EstimatorError
from forms_pipeline.shape.model import (
    FIT_CRITICAL_KEYS,
    N_STATE,
    complete_values,
    projection_jacobian,
    state_index,
)
from forms_pipeline.shape.observe import (
    PASS_THROUGH_SOURCES,
    SCAN_SOURCES,
    Observations,
    tape_sigma_mm,
)
from forms_pipeline.shape.prior import Prior

MAX_ROWS = 4096
MAX_SOURCES = 8
_SYMMETRY_TOLERANCE = 1e-9


@dataclass(frozen=True)
class PassThrough:
    value_mm: float
    source: str  # "manual" or "adjusted"


@dataclass(frozen=True, eq=False)
class Posterior:
    """Posterior over the 43-number state. `cov` is the reported covariance."""

    prior: Prior
    observations: tuple[Observations, ...]
    stature_mm: float | None
    mean: np.ndarray
    cov: np.ndarray
    pass_through: Mapping[str, PassThrough]


def _check_observations(obs: Observations) -> None:
    if obs.source not in SCAN_SOURCES | PASS_THROUGH_SOURCES:
        raise EstimatorError("bad_observations")
    index, y = np.asarray(obs.index), np.asarray(obs.y, dtype=np.float64)
    m = index.shape[0] if index.ndim == 1 else -1
    if m < 1 or y.shape != (m,) or not np.issubdtype(index.dtype, np.integer):
        raise EstimatorError("bad_observations")
    if index.min() < 0 or index.max() >= N_STATE or not np.all(np.isfinite(y)):
        raise EstimatorError("bad_observations")
    for cov in (obs.noise_cov, obs.report_cov):
        c = np.asarray(cov, dtype=np.float64)
        if c.shape != (m, m) or not np.all(np.isfinite(c)):
            raise EstimatorError("bad_noise")
        scale = max(float(np.max(np.abs(c))), 1e-300)
        if np.max(np.abs(c - c.T)) > _SYMMETRY_TOLERANCE * scale:
            raise EstimatorError("bad_noise")
        try:
            np.linalg.cholesky(c)
        except np.linalg.LinAlgError:
            raise EstimatorError("bad_noise") from None
    if obs.source in PASS_THROUGH_SOURCES:
        # Typed rows and typed values must describe the same keys, one row each.
        keys = list(obs.pass_through)
        if not keys or set(keys) - set(FIT_CRITICAL_KEYS):
            raise EstimatorError("bad_observations")
        if sorted(state_index(k) for k in keys) != sorted(int(i) for i in index):
            raise EstimatorError("bad_observations")
        values = [obs.pass_through[k] for k in keys]
        if not all(isinstance(v, float) and math.isfinite(v) and v > 0 for v in values):
            raise EstimatorError("bad_observations")
    elif obs.pass_through:
        raise EstimatorError("bad_observations")


def _gain(cov: np.ndarray, index: np.ndarray, noise: np.ndarray) -> np.ndarray:
    s = cov[np.ix_(index, index)] + noise
    try:
        factor = cho_factor(0.5 * (s + s.T), lower=True, check_finite=True)
        return cho_solve(factor, cov[index, :], check_finite=True).T
    except (LinAlgError, ValueError):
        raise EstimatorError("singular") from None


def _joseph(cov: np.ndarray, gain: np.ndarray, index: np.ndarray, noise: np.ndarray) -> np.ndarray:
    a = np.eye(cov.shape[0])
    kh = np.zeros_like(cov)
    np.add.at(kh.T, index, gain.T)
    a -= kh
    out = a @ cov @ a.T + gain @ noise @ gain.T
    return 0.5 * (out + out.T)


def condition(
    mean: np.ndarray, cov: np.ndarray, index: np.ndarray, y: np.ndarray, noise: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Gaussian conditioning on y = x[index] + e, e ~ N(0, noise)."""
    gain = _gain(cov, index, noise)
    new_mean = mean + gain @ (y - mean[index])
    return new_mean, _joseph(cov, gain, index, noise)


def condition_cov(cov: np.ndarray, index: np.ndarray, noise: np.ndarray) -> np.ndarray:
    """Covariance after conditioning on x[index] with this noise (independent of y)."""
    return _joseph(cov, _gain(cov, index, noise), index, noise)


def _stack(observations: Sequence[Observations], attr: str) -> tuple[np.ndarray, ...]:
    index = np.concatenate([o.index for o in observations]).astype(np.intp)
    y = np.concatenate([o.y for o in observations])
    m = index.shape[0]
    noise = np.zeros((m, m))
    start = 0
    for o in observations:
        n = o.rows
        noise[start : start + n, start : start + n] = getattr(o, attr)
        start += n
    return index, y, noise


def reported_covariance(prior_cov: np.ndarray, observations: Sequence[Observations]) -> np.ndarray:
    """The reported posterior covariance from a prior covariance and these observations."""
    if not observations:
        return np.array(prior_cov, dtype=np.float64, copy=True)
    index, _y, noise = _stack(observations, "report_cov")
    return condition_cov(np.asarray(prior_cov, dtype=np.float64), index, noise)


def fuse(
    prior: Prior, observations: Sequence[Observations], stature_mm: float | None = None
) -> Posterior:
    """Posterior from the prior and any number of sources (none gives the prior)."""
    obs = tuple(observations)
    if len(obs) > MAX_SOURCES:
        raise EstimatorError("too_many_sources")
    if not all(isinstance(o, Observations) for o in obs):
        raise EstimatorError("bad_observations")
    if sum(int(np.asarray(o.index).shape[0]) for o in obs) > MAX_ROWS:
        raise EstimatorError("too_many_rows")
    for o in obs:
        _check_observations(o)

    pass_through: dict[str, PassThrough] = {}
    for o in obs:
        for key, value in o.pass_through.items():
            if key in pass_through:
                raise EstimatorError("duplicate_pass_through")
            pass_through[key] = PassThrough(value_mm=float(value), source=o.source)

    prior_mean, prior_cov = prior.moments(stature_mm)
    if obs:
        index, y, noise = _stack(obs, "noise_cov")
        mean, cov = condition(prior_mean, prior_cov, index, y, noise)
        if any(o.source in PASS_THROUGH_SOURCES for o in obs):
            cov = reported_covariance(prior_cov, obs)
    else:
        mean, cov = np.array(prior_mean), np.array(prior_cov)

    if not (np.all(np.isfinite(mean)) and np.all(np.isfinite(cov))):
        raise EstimatorError("non_finite_result")
    if not np.all(np.diag(cov) > 0):
        raise EstimatorError("singular")
    mean.setflags(write=False)
    cov.setflags(write=False)
    return Posterior(
        prior=prior,
        observations=obs,
        stature_mm=stature_mm,
        mean=mean,
        cov=cov,
        pass_through=MappingProxyType(pass_through),
    )


def estimate_values(posterior: Posterior) -> dict[str, float]:
    """The 25 values: typed keys verbatim, the rest projected from the posterior mean."""
    fit = {key: math.exp(float(posterior.mean[state_index(key)])) for key in FIT_CRITICAL_KEYS}
    for key, pt in posterior.pass_through.items():
        fit[key] = pt.value_mm
    return complete_values(fit)


def value_sigmas_mm(posterior: Posterior, cov: np.ndarray | None = None) -> dict[str, float]:
    """Per-key sigma (mm) by the delta method; typed keys report their tape sigma."""
    c = posterior.cov if cov is None else cov
    jac = projection_jacobian(posterior.mean)
    var = np.einsum("ij,jk,ik->i", jac, c, jac)
    out = {key: float(math.sqrt(max(v, 0.0))) for key, v in zip(MEASUREMENT_KEYS, var, strict=True)}
    for key in posterior.pass_through:
        out[key] = tape_sigma_mm(key)
    return out


def value_sources(posterior: Posterior) -> dict[str, str]:
    """Per-key provenance: manual/adjusted, observed (a scan measured it), or inferred."""
    observed: set[int] = set()
    for o in posterior.observations:
        if o.source in SCAN_SOURCES:
            observed.update(int(i) for i in o.index)
    out: dict[str, str] = {}
    for key in MEASUREMENT_KEYS:
        if key in posterior.pass_through:
            out[key] = posterior.pass_through[key].source
        elif key in FIT_CRITICAL_KEYS and state_index(key) in observed:
            out[key] = "observed"
        else:
            out[key] = "inferred"
    return out
