"""The versioned leg prior: load, validate, assemble mu(z) and Sigma (docs/ESTIMATOR-V1.md 3).

The only IO in shape/: reading a packaged prior file, size-capped before
parsing. Every validation failure is a PriorError with a code and a fixed
message (never a value).
"""

from __future__ import annotations

import functools
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from forms_pipeline.contract import SCHEMA_VERSION
from forms_pipeline.shape.errors import EstimatorError, PriorError
from forms_pipeline.shape.model import COMPONENTS, GRID_T, IDX_L, N_STATE, K, idx_d, idx_w

PRIOR_FORMAT = "forms.leg-prior"
PRIOR_FORMAT_VERSION = 1
COVARIANCE_KIND = "level_plus_kronecker_v1"
KERNEL_KIND = "squared_exponential"
DEFAULT_PRIOR_VERSION = "0.1.1"
PRIORS_DIR = Path(__file__).resolve().parent / "priors"
MAX_PRIOR_BYTES = 1024 * 1024
GRID_TOLERANCE = 1e-9
SIGMA_MAX = 2.0
LENGTH_SCALE_MAX = 2.0
JITTER_MAX = 1e-3
STATURE_COVARIATE = "stature_mm"
# Plausible stature bounds (mm) for the covariate (ESTIMATOR-V1 3).
STATURE_MIN_MM = 600.0
STATURE_MAX_MM = 2200.0

_SEMVER = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
_TOP_KEYS = {
    "format",
    "format_version",
    "prior_version",
    "schema_version",
    "provisional",
    "provenance",
    "grid",
    "components",
    "mean",
    "covariance",
    "covariates",
}
_COV_KEYS = {
    "kind",
    "level_sigma",
    "level_correlation",
    "shape_sigma",
    "shape_correlation",
    "kernel",
    "jitter",
}
_COVARIATE_KEYS = {"name", "transform", "reference", "population_sigma", "coefficients"}


@dataclass(frozen=True)
class Covariate:
    name: str
    transform: str
    reference: float
    population_sigma: float
    coefficients: tuple[float, float, float]


@dataclass(frozen=True, eq=False)
class Prior:
    """A validated prior. `mean` and `cov` exclude covariate terms; see `moments`."""

    prior_version: str
    schema_version: str
    provisional: bool
    mean: np.ndarray
    cov: np.ndarray
    level_jacobian: np.ndarray
    covariates: tuple[Covariate, ...]

    def has_covariate(self, name: str) -> bool:
        return any(c.name == name for c in self.covariates)

    def moments(self, stature_mm: float | None = None) -> tuple[np.ndarray, np.ndarray]:
        """mu(z) and Sigma(z): a present covariate shifts the mean, an absent one is
        marginalized into the covariance."""
        if stature_mm is not None:
            check_stature(stature_mm)
        mean = self.mean.copy()
        cov = self.cov.copy()
        for cov_spec in self.covariates:
            coeffs = np.asarray(cov_spec.coefficients)
            lever = self.level_jacobian @ coeffs
            if stature_mm is not None:
                mean = mean + lever * (math.log(stature_mm) - math.log(cov_spec.reference))
            else:
                cov = cov + np.outer(lever, lever) * cov_spec.population_sigma**2
        return mean, cov


def check_stature(stature_mm: float) -> None:
    if (
        isinstance(stature_mm, bool)
        or not isinstance(stature_mm, int | float)
        or not math.isfinite(stature_mm)
        or not STATURE_MIN_MM <= stature_mm <= STATURE_MAX_MM
    ):
        raise EstimatorError("bad_stature")


def level_jacobian() -> np.ndarray:
    """J (43 x 3): each state entry's level component (log_L, log_w, log_d)."""
    j = np.zeros((N_STATE, 3))
    j[IDX_L, 0] = 1.0
    for k in range(K):
        j[idx_w(k), 1] = 1.0
        j[idx_d(k), 2] = 1.0
    return j


def se_kernel(t: np.ndarray, length_scale: float) -> np.ndarray:
    t = np.asarray(t, dtype=np.float64)
    diff = t[:, None] - t[None, :]
    return np.exp(-(diff**2) / (2.0 * length_scale**2))


def assemble_covariance(
    level_sigma: np.ndarray,
    level_correlation: np.ndarray,
    shape_sigma: np.ndarray,
    shape_correlation: np.ndarray,
    length_scale_t: float,
    jitter: float,
) -> np.ndarray:
    """Sigma = J C_level J^T + blockdiag(0, kron(C_shape, K)) (PSD by construction)."""
    c_level = np.diag(level_sigma) @ level_correlation @ np.diag(level_sigma)
    c_shape = np.diag(shape_sigma) @ shape_correlation @ np.diag(shape_sigma)
    kern = se_kernel(GRID_T, length_scale_t) + jitter * np.eye(K)
    j = level_jacobian()
    sigma = j @ c_level @ j.T
    sigma[1:, 1:] += np.kron(c_shape, kern)
    return 0.5 * (sigma + sigma.T)


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise PriorError(code)


def _is_number(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def _vector(value: Any, length: int, code: str = "prior_malformed") -> np.ndarray:
    _require(isinstance(value, list) and len(value) == length, code)
    _require(all(_is_number(v) for v in value), "prior_malformed")
    arr = np.asarray(value, dtype=np.float64)
    _require(bool(np.all(np.isfinite(arr))), "prior_non_finite")
    return arr


def _matrix(value: Any, n: int) -> np.ndarray:
    _require(isinstance(value, list) and len(value) == n, "prior_malformed")
    return np.vstack([_vector(row, n) for row in value])


def _sigmas(arr: np.ndarray) -> None:
    _require(bool(np.all((arr > 0) & (arr <= SIGMA_MAX))), "prior_sigma")


def _correlation(arr: np.ndarray) -> None:
    ok = np.array_equal(arr, arr.T) and np.all(np.diag(arr) == 1.0)
    ok = ok and bool(np.all(np.abs(arr) <= 1.0))
    _require(bool(ok), "prior_correlation")
    try:
        np.linalg.cholesky(arr)
    except np.linalg.LinAlgError:
        raise PriorError("prior_correlation") from None


def _covariates(value: Any) -> tuple[Covariate, ...]:
    _require(isinstance(value, list), "prior_malformed")
    out: list[Covariate] = []
    for entry in value:
        _require(isinstance(entry, dict) and set(entry) == _COVARIATE_KEYS, "prior_covariate")
        # format_version 1 allows only log stature.
        _require(entry["name"] == STATURE_COVARIATE, "prior_covariate")
        _require(entry["transform"] == "log", "prior_covariate")
        ref, pop = entry["reference"], entry["population_sigma"]
        _require(_is_number(ref) and _is_number(pop), "prior_covariate")
        _require(math.isfinite(ref) and STATURE_MIN_MM <= ref <= STATURE_MAX_MM, "prior_covariate")
        _require(math.isfinite(pop) and 0 < pop <= SIGMA_MAX, "prior_covariate")
        coeffs = _vector(entry["coefficients"], 3, "prior_covariate")
        _require(bool(np.all(np.abs(coeffs) <= 10.0)), "prior_covariate")
        out.append(
            Covariate(
                name=entry["name"],
                transform=entry["transform"],
                reference=float(ref),
                population_sigma=float(pop),
                coefficients=(float(coeffs[0]), float(coeffs[1]), float(coeffs[2])),
            )
        )
    _require(len({c.name for c in out}) == len(out), "prior_covariate")
    return tuple(out)


def parse_prior(data: Any) -> Prior:
    """Validate a parsed prior document and assemble its moments."""
    _require(isinstance(data, dict) and set(data) == _TOP_KEYS, "prior_malformed")
    _require(data["format"] == PRIOR_FORMAT, "prior_format")
    fv = data["format_version"]
    _require(
        isinstance(fv, int) and not isinstance(fv, bool) and fv == PRIOR_FORMAT_VERSION,
        "prior_format",
    )
    pv = data["prior_version"]
    _require(isinstance(pv, str) and bool(_SEMVER.fullmatch(pv)), "prior_version")
    _require(data["schema_version"] == SCHEMA_VERSION, "prior_schema_version")
    _require(isinstance(data["provisional"], bool), "prior_malformed")
    _require(isinstance(data["provenance"], str), "prior_malformed")

    grid = data["grid"]
    _require(isinstance(grid, dict) and set(grid) == {"K", "t"}, "prior_malformed")
    _require(isinstance(grid["K"], int) and grid["K"] == K, "prior_grid")
    t = _vector(grid["t"], K, "prior_grid")
    _require(bool(np.all(np.abs(t - GRID_T) <= GRID_TOLERANCE)), "prior_grid")

    _require(data["components"] == list(COMPONENTS), "prior_components")

    mean_doc = data["mean"]
    _require(isinstance(mean_doc, dict) and set(mean_doc) == set(COMPONENTS), "prior_malformed")
    log_l = mean_doc["log_L"]
    _require(_is_number(log_l), "prior_malformed")
    _require(math.isfinite(log_l), "prior_non_finite")
    mean = np.concatenate(
        [[float(log_l)], _vector(mean_doc["log_w"], K), _vector(mean_doc["log_d"], K)]
    )

    cov_doc = data["covariance"]
    _require(isinstance(cov_doc, dict) and set(cov_doc) == _COV_KEYS, "prior_malformed")
    _require(cov_doc["kind"] == COVARIANCE_KIND, "prior_malformed")
    level_sigma = _vector(cov_doc["level_sigma"], 3)
    shape_sigma = _vector(cov_doc["shape_sigma"], 2)
    _sigmas(level_sigma)
    _sigmas(shape_sigma)
    level_corr = _matrix(cov_doc["level_correlation"], 3)
    shape_corr = _matrix(cov_doc["shape_correlation"], 2)
    _correlation(level_corr)
    _correlation(shape_corr)
    kernel = cov_doc["kernel"]
    _require(isinstance(kernel, dict) and set(kernel) == {"kind", "length_scale_t"}, "prior_kernel")
    _require(kernel["kind"] == KERNEL_KIND, "prior_kernel")
    ls = kernel["length_scale_t"]
    _require(_is_number(ls) and math.isfinite(ls) and 0 < ls <= LENGTH_SCALE_MAX, "prior_kernel")
    jitter = cov_doc["jitter"]
    _require(
        _is_number(jitter) and math.isfinite(jitter) and 0 < jitter <= JITTER_MAX, "prior_jitter"
    )

    covariates = _covariates(data["covariates"])
    cov = assemble_covariance(
        level_sigma, level_corr, shape_sigma, shape_corr, float(ls), float(jitter)
    )
    _require(bool(np.all(np.isfinite(cov))), "prior_not_positive_definite")
    try:
        np.linalg.cholesky(cov)
    except np.linalg.LinAlgError:
        raise PriorError("prior_not_positive_definite") from None

    jac = level_jacobian()
    for arr in (mean, cov, jac):
        arr.setflags(write=False)
    return Prior(
        prior_version=pv,
        schema_version=data["schema_version"],
        provisional=data["provisional"],
        mean=mean,
        cov=cov,
        level_jacobian=jac,
        covariates=covariates,
    )


def parse_prior_bytes(raw: bytes) -> Prior:
    _require(len(raw) <= MAX_PRIOR_BYTES, "prior_too_large")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        raise PriorError("prior_not_json") from None
    return parse_prior(data)


def read_prior_file(path: Path) -> Prior:
    """Read and validate a prior file, never reading more than MAX_PRIOR_BYTES + 1."""
    try:
        with path.open("rb") as f:
            raw = f.read(MAX_PRIOR_BYTES + 1)
    except OSError:
        raise PriorError("prior_missing") from None
    return parse_prior_bytes(raw)


@functools.lru_cache(maxsize=4)
def load_prior(prior_version: str = DEFAULT_PRIOR_VERSION) -> Prior:
    """The packaged prior of this version."""
    _require(bool(_SEMVER.fullmatch(prior_version)), "prior_version")
    prior = read_prior_file(PRIORS_DIR / f"prior-{prior_version}.json")
    _require(prior.prior_version == prior_version, "prior_version")
    return prior
