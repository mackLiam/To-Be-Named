"""shape/prior.py: the shipped prior, its provenance, its covariance, and every refusal."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from scipy.interpolate import PchipInterpolator
from test_silhouette import ANKLE_H, KNEE_H, PROFILE, truth_values

from forms_pipeline.contract import SCHEMA
from forms_pipeline.shape.errors import EstimatorError, PriorError
from forms_pipeline.shape.model import (
    FIT_CRITICAL_KEYS,
    GRID_T,
    LEG_LENGTH_KEY,
    N_STATE,
    SLICE_K,
    K,
    project,
)
from forms_pipeline.shape.prior import (
    DEFAULT_PRIOR_VERSION,
    MAX_PRIOR_BYTES,
    PRIORS_DIR,
    Prior,
    load_prior,
    parse_prior,
    parse_prior_bytes,
    read_prior_file,
)

SHIPPED = PRIORS_DIR / "prior-0.1.1.json"
LEGACY = "0.1.0"  # superseded, kept loadable: versions are never edited in place
OD_OW_TOL = 0.02
STATURE_ENTRY = {
    "name": "stature_mm",
    "transform": "log",
    "reference": 1700.0,
    "population_sigma": 0.06,
    "coefficients": [1.0, 0.5, 0.5],
}  # test data only, never shipped (ESTIMATOR-V1 3)


def shipped_doc() -> dict[str, Any]:
    return json.loads(SHIPPED.read_text(encoding="utf-8"))


def stature_prior() -> Prior:
    doc = shipped_doc()
    doc["covariates"] = [dict(STATURE_ENTRY)]
    return parse_prior(doc)


def _no_digits(exc: BaseException) -> bool:
    return not any(ch.isdigit() for ch in str(exc))


def test_shipped_prior_validates() -> None:
    assert DEFAULT_PRIOR_VERSION == "0.1.1"
    prior = load_prior()
    assert prior.prior_version == "0.1.1"
    assert prior.schema_version == "1.1.0"
    assert prior.provisional is True
    assert prior.covariates == ()
    assert prior.mean.shape == (N_STATE,) and prior.cov.shape == (N_STATE, N_STATE)
    assert load_prior() is load_prior()  # cached, read once
    assert "TODO(liam)" in shipped_doc()["provenance"]


def _semi_axes() -> np.ndarray:
    pchip = PchipInterpolator(PROFILE[:, 0], PROFILE[:, 1:], axis=0)
    return pchip(ANKLE_H + GRID_T * (KNEE_H - ANKLE_H))[:, :2]


def test_mean_matches_its_provenance() -> None:
    """ESTIMATOR-V1 3: OW is the larger section extent, OD the smaller, as in extraction."""
    a, b = _semi_axes().T
    prior = load_prior()
    assert prior.mean[0] == pytest.approx(math.log(380.0), abs=1e-5)
    np.testing.assert_allclose(prior.mean[1 : 1 + K], np.log(2000.0 * np.maximum(a, b)), atol=1e-5)
    np.testing.assert_allclose(prior.mean[1 + K :], np.log(2000.0 * np.minimum(a, b)), atol=1e-5)
    assert "max(a, b)" in shipped_doc()["provenance"]


def test_legacy_mean_matches_its_own_provenance() -> None:
    """Record of 0.1.0: OW from the mediolateral semi-axis, OD from the forward one."""
    a, b = _semi_axes().T
    prior = load_prior(LEGACY)
    assert prior.prior_version == LEGACY
    assert prior.mean[0] == pytest.approx(math.log(380.0), abs=1e-5)
    np.testing.assert_allclose(prior.mean[1 : 1 + K], np.log(2000.0 * a), atol=1e-5)
    np.testing.assert_allclose(prior.mean[1 + K :], np.log(2000.0 * b), atol=1e-5)


def test_only_mean_version_and_provenance_differ_from_legacy() -> None:
    legacy = json.loads((PRIORS_DIR / f"prior-{LEGACY}.json").read_text(encoding="utf-8"))
    doc = shipped_doc()
    for key in set(doc) - {"prior_version", "provenance", "mean"}:
        assert doc[key] == legacy[key], key
    assert doc["mean"]["log_L"] == legacy["mean"]["log_L"]


def _od_ow_gap(prior_version: str) -> float:
    """Largest |OD/OW| difference at S1..S4 between a prior mean and extraction on the truth leg."""
    mean = project(load_prior(prior_version).mean)
    truth = truth_values()
    return max(
        abs(mean[f"{s}_OD"] / mean[f"{s}_OW"] - truth[f"{s}_OD"] / truth[f"{s}_OW"])
        for s in SLICE_K
    )


def test_mean_od_ow_matches_extraction_on_the_truth_leg() -> None:
    """The prior and the observations must agree on which extent is OW (ESTIMATOR-V1 3)."""
    assert _od_ow_gap(DEFAULT_PRIOR_VERSION) <= OD_OW_TOL
    assert _od_ow_gap(LEGACY) > OD_OW_TOL  # the 0.1.0 definition mismatch this pins


def test_level_sigmas_rederive_from_the_schema() -> None:
    props = SCHEMA["properties"]
    leg = props[LEG_LENGTH_KEY]
    slice_ranges = {(props[k]["minimum"], props[k]["maximum"]) for k in FIT_CRITICAL_KEYS[1:]}
    assert len(slice_ranges) == 1  # every OW and OD shares one range
    ((lo, hi),) = slice_ranges
    expected = [
        math.log(leg["maximum"] / leg["minimum"]) / 4,
        math.log(hi / lo) / 4,
        math.log(hi / lo) / 4,
    ]
    np.testing.assert_allclose(
        shipped_doc()["covariance"]["level_sigma"], expected, atol=1e-5, rtol=0
    )


def test_covariance_is_symmetric_psd_and_follows_the_formula() -> None:
    prior = load_prior()
    sigma = prior.cov
    assert np.array_equal(sigma, sigma.T)
    np.linalg.cholesky(sigma)
    # Independent element-wise re-derivation of ESTIMATOR-V1 section 3.
    cov = shipped_doc()["covariance"]
    ls, lc = np.array(cov["level_sigma"]), np.array(cov["level_correlation"])
    ss, sc = np.array(cov["shape_sigma"]), np.array(cov["shape_correlation"])
    length, jitter = cov["kernel"]["length_scale_t"], cov["jitter"]

    def comp(i: int) -> tuple[int, int | None]:
        return (0, None) if i == 0 else ((1, i - 1) if i <= K else (2, i - 1 - K))

    expected = np.zeros((N_STATE, N_STATE))
    for i in range(N_STATE):
        for j in range(N_STATE):
            ci, ki = comp(i)
            cj, kj = comp(j)
            v = ls[ci] * lc[ci, cj] * ls[cj]
            if ki is not None and kj is not None:
                kern = math.exp(-((GRID_T[ki] - GRID_T[kj]) ** 2) / (2 * length**2))
                kern += jitter if ki == kj else 0.0
                v += ss[ci - 1] * sc[ci - 1, cj - 1] * ss[cj - 1] * kern
            expected[i, j] = v
    np.testing.assert_allclose(sigma, expected, rtol=1e-12, atol=1e-15)


def _mutate(path: list[Any], value: Any) -> dict[str, Any]:
    doc = shipped_doc()
    target = doc
    for p in path[:-1]:
        target = target[p]
    target[path[-1]] = value
    return doc


def _shift_grid() -> dict[str, Any]:
    doc = shipped_doc()
    doc["grid"]["t"] = [t + 1e-6 for t in doc["grid"]["t"]]
    return doc


def _k20() -> dict[str, Any]:
    doc = shipped_doc()
    doc["grid"] = {"K": 20, "t": [k / 19 for k in range(20)]}
    return doc


def _with_covariate(**changes: Any) -> dict[str, Any]:
    doc = shipped_doc()
    entry = dict(STATURE_ENTRY)
    entry.update(changes)
    doc["covariates"] = [entry]
    return doc


REFUSALS: list[tuple[str, Any, str]] = [
    ("format_version 2", lambda: _mutate(["format_version"], 2), "prior_format"),
    ("format_version true", lambda: _mutate(["format_version"], True), "prior_format"),
    ("wrong format", lambda: _mutate(["format"], "forms.other"), "prior_format"),
    ("K 20", _k20, "prior_grid"),
    ("K 20 only", lambda: _mutate(["grid", "K"], 20), "prior_grid"),
    ("shifted grid", _shift_grid, "prior_grid"),
    (
        "reordered components",
        lambda: _mutate(["components"], ["log_w", "log_L", "log_d"]),
        "prior_components",
    ),
    ("nan mean", lambda: _mutate(["mean", "log_L"], float("nan")), "prior_non_finite"),
    (
        "inf in log_w",
        lambda: _mutate(["mean", "log_w"], [float("inf")] + [4.0] * 20),
        "prior_non_finite",
    ),
    ("short log_d", lambda: _mutate(["mean", "log_d"], [4.0] * 20), "prior_malformed"),
    (
        "negative sigma",
        lambda: _mutate(["covariance", "level_sigma"], [0.3, -0.5, 0.5]),
        "prior_sigma",
    ),
    ("zero shape sigma", lambda: _mutate(["covariance", "shape_sigma"], [0.0, 0.1]), "prior_sigma"),
    ("sigma above 2", lambda: _mutate(["covariance", "shape_sigma"], [2.5, 0.1]), "prior_sigma"),
    (
        "non-PSD correlation",
        lambda: _mutate(
            ["covariance", "level_correlation"],
            [[1.0, 0.9, -0.9], [0.9, 1.0, 0.9], [-0.9, 0.9, 1.0]],
        ),
        "prior_correlation",
    ),
    (
        "asymmetric correlation",
        lambda: _mutate(["covariance", "shape_correlation"], [[1.0, 0.5], [0.4, 1.0]]),
        "prior_correlation",
    ),
    (
        "non-unit diagonal",
        lambda: _mutate(["covariance", "shape_correlation"], [[0.9, 0.5], [0.5, 1.0]]),
        "prior_correlation",
    ),
    (
        "length scale zero",
        lambda: _mutate(["covariance", "kernel", "length_scale_t"], 0.0),
        "prior_kernel",
    ),
    (
        "unknown kernel",
        lambda: _mutate(["covariance", "kernel", "kind"], "matern"),
        "prior_kernel",
    ),
    ("jitter zero", lambda: _mutate(["covariance", "jitter"], 0.0), "prior_jitter"),
    ("jitter too big", lambda: _mutate(["covariance", "jitter"], 0.01), "prior_jitter"),
    ("bad semver", lambda: _mutate(["prior_version"], "0.1"), "prior_version"),
    ("semver newline", lambda: _mutate(["prior_version"], "0.1.0\n"), "prior_version"),
    ("schema mismatch", lambda: _mutate(["schema_version"], "1.0.0"), "prior_schema_version"),
    ("unknown key", lambda: _mutate(["extra"], 1), "prior_malformed"),
    ("provisional not bool", lambda: _mutate(["provisional"], "yes"), "prior_malformed"),
    ("covariate name", lambda: _with_covariate(name="age_years"), "prior_covariate"),
    ("covariate transform", lambda: _with_covariate(transform="linear"), "prior_covariate"),
    (
        "covariate coefficients",
        lambda: _with_covariate(coefficients=[1.0, 0.5]),
        "prior_covariate",
    ),
    ("covariate sigma", lambda: _with_covariate(population_sigma=-0.1), "prior_covariate"),
    ("covariate reference", lambda: _with_covariate(reference=100.0), "prior_covariate"),
    ("covariate extra key", lambda: _with_covariate(extra=1), "prior_covariate"),
]


@pytest.mark.parametrize(("name", "make", "code"), REFUSALS, ids=[r[0] for r in REFUSALS])
def test_refusals(name: str, make: Any, code: str) -> None:
    with pytest.raises(PriorError) as info:
        parse_prior(make())
    assert info.value.code == code, name
    assert _no_digits(info.value)


def test_not_a_dict_is_refused() -> None:
    for bad in (None, [], "prior"):
        with pytest.raises(PriorError) as info:
            parse_prior(bad)
        assert info.value.code == "prior_malformed"


def test_nan_in_raw_json_is_refused() -> None:
    raw = SHIPPED.read_bytes().replace(b'"log_L": 5.940171', b'"log_L": NaN')
    assert b"NaN" in raw
    with pytest.raises(PriorError) as info:
        parse_prior_bytes(raw)
    assert info.value.code == "prior_non_finite"


def test_oversized_file_is_refused_before_parsing(tmp_path: Path) -> None:
    big = tmp_path / "prior-9.9.9.json"
    big.write_bytes(b" " * MAX_PRIOR_BYTES + SHIPPED.read_bytes())
    with pytest.raises(PriorError) as info:
        read_prior_file(big)
    assert info.value.code == "prior_too_large"
    with pytest.raises(PriorError) as info:
        parse_prior_bytes(b" " * (MAX_PRIOR_BYTES + 1))
    assert info.value.code == "prior_too_large"


def test_not_json_and_missing_files(tmp_path: Path) -> None:
    with pytest.raises(PriorError) as info:
        parse_prior_bytes(b"{not json")
    assert info.value.code == "prior_not_json"
    with pytest.raises(PriorError) as info:
        read_prior_file(tmp_path / "absent.json")
    assert info.value.code == "prior_missing"
    with pytest.raises(PriorError) as info:
        load_prior("../../secrets")
    assert info.value.code == "prior_version"
    with pytest.raises(PriorError) as info:
        load_prior("9.9.9")
    assert info.value.code == "prior_missing"


def test_prior_error_is_an_estimator_error_with_fixed_message() -> None:
    a, b = PriorError("prior_grid"), PriorError("prior_sigma")
    assert isinstance(a, EstimatorError)
    assert str(a) == str(b) and _no_digits(a)
    assert PriorError("not a code").code == "internal"


def test_stature_present_shifts_the_mean() -> None:
    base = load_prior()
    prior = stature_prior()
    mean_absent, _ = prior.moments(None)
    np.testing.assert_array_equal(mean_absent, base.mean)
    mean, cov = prior.moments(1870.0)
    shift = math.log(1870.0) - math.log(1700.0)
    assert mean[0] - base.mean[0] == pytest.approx(1.0 * shift, rel=1e-12)
    np.testing.assert_allclose(mean[1 : 1 + K] - base.mean[1 : 1 + K], 0.5 * shift, rtol=1e-12)
    np.testing.assert_allclose(mean[1 + K :] - base.mean[1 + K :], 0.5 * shift, rtol=1e-12)
    np.testing.assert_array_equal(cov, base.cov)
    at_reference, _ = prior.moments(1700.0)
    np.testing.assert_allclose(at_reference, base.mean, atol=1e-15)


def test_stature_absent_marginalizes_with_larger_variance() -> None:
    base = load_prior()
    prior = stature_prior()
    _, cov = prior.moments(None)
    lever = prior.level_jacobian @ np.array([1.0, 0.5, 0.5])
    np.testing.assert_allclose(cov, base.cov + np.outer(lever, lever) * 0.06**2, rtol=1e-12)
    assert np.all(np.diag(cov) > np.diag(base.cov))
    np.linalg.cholesky(cov)


@pytest.mark.parametrize("stature", [599.0, 2201.0, float("nan"), float("inf"), True, "1700"])
def test_out_of_range_stature_raises(stature: Any) -> None:
    for prior in (stature_prior(), load_prior()):
        with pytest.raises(EstimatorError) as info:
            prior.moments(stature)
        assert info.value.code == "bad_stature"
        assert _no_digits(info.value)


def test_parse_does_not_mutate_input() -> None:
    doc = shipped_doc()
    before = copy.deepcopy(doc)
    parse_prior(doc)
    assert doc == before
