"""shape/fuse.py: recovery, monotone information, gap cases, calibration, caps, failures."""

from __future__ import annotations

import math
from types import MappingProxyType

import numpy as np
import pytest
from test_shape_model import synthetic_state
from test_shape_observe import profile_from_state
from test_shape_prior import stature_prior

from forms_pipeline.contract import MEASUREMENT_KEYS
from forms_pipeline.shape.errors import EstimatorError
from forms_pipeline.shape.fuse import (
    MAX_ROWS,
    MAX_SOURCES,
    Posterior,
    estimate_values,
    fuse,
    value_sigmas_mm,
    value_sources,
)
from forms_pipeline.shape.model import (
    FIT_CRITICAL_KEYS,
    GRID_T,
    IDX_L,
    INNER_KEYS,
    LEG_LENGTH_KEY,
    N_STATE,
    SLICE_K,
    idx_d,
    idx_w,
    project,
    state_index,
)
from forms_pipeline.shape.observe import (
    MANUAL_KEYS,
    OBSERVABLE_K,
    Observations,
    SectionProfile,
    observations_from_manual,
    observations_from_profile,
)
from forms_pipeline.shape.prior import load_prior

PRIOR = load_prior()
FIT_IDX = np.array([state_index(k) for k in FIT_CRITICAL_KEYS])


def truth_state() -> np.ndarray:
    return synthetic_state(leg_length_mm=395.0, width_scale=1.08, depth_ratio=0.85)


def manual_values(x: np.ndarray, factor: float = 1.0) -> dict[str, float]:
    values = project(x)
    return {k: values[k] * factor for k in MANUAL_KEYS}


def _no_digits(exc: BaseException) -> bool:
    return not any(ch.isdigit() for ch in str(exc))


def _prior_sd(key: str) -> float:
    i = state_index(key)
    return math.exp(PRIOR.mean[i]) * math.sqrt(PRIOR.cov[i, i])


def test_prior_only_is_the_prior() -> None:
    post = fuse(PRIOR, [])
    np.testing.assert_array_equal(post.mean, PRIOR.mean)
    np.testing.assert_array_equal(post.cov, PRIOR.cov)
    assert set(value_sources(post).values()) == {"inferred"}


def test_full_observations_recover_truth_within_one_percent() -> None:
    x = truth_state()
    post = fuse(PRIOR, [observations_from_profile(profile_from_state(x, "mesh"))])
    truth = project(x)
    est = estimate_values(post)
    for key in MEASUREMENT_KEYS:
        assert est[key] == pytest.approx(truth[key], rel=0.01), key
    sources = value_sources(post)
    assert all(sources[k] == "observed" for k in FIT_CRITICAL_KEYS)
    assert all(sources[k] == "inferred" for k in INNER_KEYS)


def _all_sources(x: np.ndarray) -> list[Observations]:
    return [
        observations_from_profile(profile_from_state(x, "mesh")),
        observations_from_profile(profile_from_state(x, "silhouette", span=170.0)),
        observations_from_manual(manual_values(x), adjusted=False),
    ]


@pytest.mark.parametrize("drop", [0, 1, 2])
def test_dropping_any_source_widens_sigma_and_keeps_mean_within_two_sigma(drop: int) -> None:
    x = truth_state()
    sources = _all_sources(x)
    full = fuse(PRIOR, sources)
    fewer = fuse(PRIOR, [s for i, s in enumerate(sources) if i != drop])
    var_full, var_fewer = np.diag(full.cov), np.diag(fewer.cov)
    assert np.all(var_fewer >= var_full * (1 - 1e-9))
    assert var_fewer.sum() > var_full.sum() * (1 + 1e-6)
    truth = project(x)
    est, sd = estimate_values(fewer), value_sigmas_mm(fewer)
    for key in FIT_CRITICAL_KEYS:
        assert abs(est[key] - truth[key]) <= 2 * sd[key], key


def test_missing_top_twenty_percent_leans_on_the_kernel() -> None:
    x = truth_state()
    ks = tuple(k for k in OBSERVABLE_K if k <= 15)
    post = fuse(PRIOR, [observations_from_profile(profile_from_state(x, "mesh", ks=ks))])
    sd, est, truth = value_sigmas_mm(post), estimate_values(post), project(x)
    sources = value_sources(post)
    assert sources["S4_OW"] == "inferred" and sources["S3_OW"] == "observed"
    for dim in ("OW", "OD"):
        assert sd[f"S3_{dim}"] < sd[f"S4_{dim}"] < _prior_sd(f"S4_{dim}")
        assert abs(est[f"S4_{dim}"] - truth[f"S4_{dim}"]) <= 2 * sd[f"S4_{dim}"]


def test_missing_all_depth_leaves_depth_near_the_prior() -> None:
    x = truth_state()
    widths_only = {k: v for k, v in manual_values(x).items() if not k.endswith("_OD")}
    post = fuse(PRIOR, [observations_from_manual(widths_only, adjusted=False)])
    sd = value_sigmas_mm(post)
    sources = value_sources(post)
    for s in SLICE_K:
        assert sources[f"{s}_OW"] == "manual" and sources[f"{s}_OD"] == "inferred"
        assert sd[f"{s}_OD"] > 0.7 * _prior_sd(f"{s}_OD")
        assert sd[f"{s}_OD"] > 5 * sd[f"{s}_OW"]
    est = estimate_values(post)
    for k, v in widths_only.items():
        assert est[k] == v


def test_one_sided_capture_widens_depth_not_width() -> None:
    x = truth_state()
    narrow = fuse(
        PRIOR, [observations_from_profile(profile_from_state(x, "silhouette", span=30.0))]
    )
    wide = fuse(PRIOR, [observations_from_profile(profile_from_state(x, "silhouette", span=180.0))])
    sd_n, sd_w = value_sigmas_mm(narrow), value_sigmas_mm(wide)
    for s in SLICE_K:
        assert sd_n[f"{s}_OD"] > sd_w[f"{s}_OD"] * 1.3
        assert sd_n[f"{s}_OW"] == pytest.approx(sd_w[f"{s}_OW"], rel=0.15)
    truth, est = project(x), estimate_values(narrow)
    for key in FIT_CRITICAL_KEYS:
        assert abs(est[key] - truth[key]) <= 2 * sd_n[key]


def test_conflicting_mesh_and_manual_sources() -> None:
    x = truth_state()
    typed = manual_values(x, factor=1.10)
    mesh = observations_from_profile(profile_from_state(x, "mesh"))
    post = fuse(PRIOR, [mesh, observations_from_manual(typed, adjusted=True)])
    assert np.all(np.isfinite(post.mean)) and np.all(np.isfinite(post.cov))
    est = estimate_values(post)
    for key, v in typed.items():
        assert est[key] == v  # typed values pass through unchanged
        assert math.exp(post.mean[state_index(key)]) == pytest.approx(v, abs=0.1)
    assert value_sources(post)["S1_OW"] == "adjusted"
    # Between slices the estimate sits between the two sources (within 0.5%): the
    # correlated per-capture noise lets the typed values recalibrate the whole capture.
    for k in (6, 10, 14):
        for i in (idx_w(k), idx_d(k)):
            assert x[i] < post.mean[i] < x[i] + math.log(1.10) + 0.005
    # Inner keys follow the typed widths and depths.
    for s in SLICE_K:
        assert est[f"{s}_ISW"] == est[f"{s}_ICW"] == typed[f"{s}_OW"] / 2
        assert est[f"{s}_ISD"] == est[f"{s}_ICD"] == typed[f"{s}_OD"]


def test_manual_only_equals_the_symmetric_split() -> None:
    # The values apps/app/src/lib/manualMeasurements.ts derives with no scan.
    typed = {"Leg_Length": 372.5, "S1_OW": 71.3, "S1_OD": 66.0, "S2_OW": 88.9, "S2_OD": 81.2}
    typed |= {"S3_OW": 95.1, "S3_OD": 90.4, "S4_OW": 92.7, "S4_OD": 88.8}
    post = fuse(PRIOR, [observations_from_manual(typed, adjusted=False)])
    est = estimate_values(post)
    for key, v in typed.items():
        assert est[key] == v
    for s in SLICE_K:
        assert est[f"{s}_ISW"] == typed[f"{s}_OW"] / 2
        assert est[f"{s}_ICW"] == typed[f"{s}_OW"] / 2
        assert est[f"{s}_ISD"] == typed[f"{s}_OD"]
        assert est[f"{s}_ICD"] == typed[f"{s}_OD"]
    sd = value_sigmas_mm(post)
    assert sd["Leg_Length"] == 5.0 and sd["S2_OW"] == 3.0 and sd["S2_OD"] == 3.0


def _obs(index: list[int], y: list[float], cov: np.ndarray, source: str = "mesh") -> Observations:
    return Observations(
        source=source,  # type: ignore[arg-type]
        index=np.array(index),
        y=np.array(y, dtype=np.float64),
        noise_cov=cov,
        report_cov=cov,
        pass_through=MappingProxyType({}),
    )


DEGENERATE = [
    ("nan y", lambda: _obs([0], [float("nan")], np.eye(1) * 1e-3), "bad_observations"),
    ("inf y", lambda: _obs([0], [float("inf")], np.eye(1) * 1e-3), "bad_observations"),
    ("index out of range", lambda: _obs([N_STATE], [4.0], np.eye(1) * 1e-3), "bad_observations"),
    ("negative index", lambda: _obs([-1], [4.0], np.eye(1) * 1e-3), "bad_observations"),
    ("float index", lambda: _obs([0.0], [4.0], np.eye(1) * 1e-3), "bad_observations"),  # type: ignore[list-item]
    ("empty", lambda: _obs([], [], np.zeros((0, 0))), "bad_observations"),
    ("shape mismatch", lambda: _obs([0, 1], [5.9], np.eye(2) * 1e-3), "bad_observations"),
    ("zero noise", lambda: _obs([0], [5.9], np.zeros((1, 1))), "bad_noise"),
    ("negative noise", lambda: _obs([0], [5.9], -np.eye(1)), "bad_noise"),
    ("nan noise", lambda: _obs([0], [5.9], np.full((1, 1), np.nan)), "bad_noise"),
    ("noise wrong shape", lambda: _obs([0], [5.9], np.eye(2)), "bad_noise"),
    (
        "asymmetric noise",
        lambda: _obs([0, 1], [5.9, 4.0], np.array([[1.0, 0.5], [0.0, 1.0]])),
        "bad_noise",
    ),
    ("unknown source", lambda: _obs([0], [5.9], np.eye(1) * 1e-3, "lidar"), "bad_observations"),
]


@pytest.mark.parametrize(("name", "make", "code"), DEGENERATE, ids=[d[0] for d in DEGENERATE])
def test_degenerate_inputs_raise_without_digits(name: str, make: object, code: str) -> None:
    with pytest.raises(EstimatorError) as info:
        fuse(PRIOR, [make()])  # type: ignore[operator]
    assert info.value.code == code, name
    assert _no_digits(info.value)


def test_non_observation_objects_and_duplicate_pass_through_raise() -> None:
    with pytest.raises(EstimatorError) as info:
        fuse(PRIOR, ["not observations"])  # type: ignore[list-item]
    assert info.value.code == "bad_observations"
    a = observations_from_manual({"S1_OW": 80.0}, adjusted=False)
    b = observations_from_manual({"S1_OW": 82.0}, adjusted=True)
    with pytest.raises(EstimatorError) as info:
        fuse(PRIOR, [a, b])
    assert info.value.code == "duplicate_pass_through" and _no_digits(info.value)


def test_scan_source_may_not_carry_pass_through() -> None:
    obs = observations_from_profile(profile_from_state(truth_state()))
    forged = Observations(
        source="mesh",
        index=obs.index,
        y=obs.y,
        noise_cov=obs.noise_cov,
        report_cov=obs.report_cov,
        pass_through=MappingProxyType({"S1_OW": 80.0}),
    )
    with pytest.raises(EstimatorError) as info:
        fuse(PRIOR, [forged])
    assert info.value.code == "bad_observations"


@pytest.mark.parametrize(
    "pass_through",
    [
        {"S1_OD": 80.0},
        {"S1_OW": 80.0, "S1_OD": 70.0},
        {"S1_OW": float("nan")},
        {"S1_OW": -80.0},
        {"S1_ISW": 40.0},
        {},
    ],
)
def test_typed_rows_must_match_typed_values(pass_through: dict[str, float]) -> None:
    obs = observations_from_manual({"S1_OW": 80.0}, adjusted=False)
    forged = Observations(
        source="manual",
        index=obs.index,
        y=obs.y,
        noise_cov=obs.noise_cov,
        report_cov=obs.report_cov,
        pass_through=MappingProxyType(pass_through),
    )
    with pytest.raises(EstimatorError) as info:
        fuse(PRIOR, [forged])
    assert info.value.code == "bad_observations"


def test_source_cap() -> None:
    x = truth_state()
    one = observations_from_profile(profile_from_state(x, "silhouette", span=170.0))
    fuse(PRIOR, [one] * MAX_SOURCES)
    with pytest.raises(EstimatorError) as info:
        fuse(PRIOR, [one] * (MAX_SOURCES + 1))
    assert info.value.code == "too_many_sources" and _no_digits(info.value)


def test_row_cap() -> None:
    rows = MAX_ROWS + 1
    big = _obs([0] * rows, [5.9] * rows, np.eye(rows) * 1e-2)
    with pytest.raises(EstimatorError) as info:
        fuse(PRIOR, [big])
    assert info.value.code == "too_many_rows" and _no_digits(info.value)
    half = _obs([0] * (MAX_ROWS // 2 + 1), [5.9] * (MAX_ROWS // 2 + 1), np.eye(1) * 1e-2)
    with pytest.raises(EstimatorError) as info:
        fuse(PRIOR, [half, half])  # the cap is on total rows across sources
    assert info.value.code == "too_many_rows"


def test_stature_covariate_through_fusion() -> None:
    prior = stature_prior()
    x = truth_state()
    mesh = observations_from_profile(profile_from_state(x, "silhouette", span=170.0))
    without = fuse(prior, [mesh])
    with_stature = fuse(prior, [mesh], stature_mm=1750.0)
    assert with_stature.stature_mm == 1750.0
    assert np.all(np.diag(with_stature.cov) <= np.diag(without.cov) * (1 + 1e-12))
    assert np.diag(with_stature.cov).sum() < np.diag(without.cov).sum()
    with pytest.raises(EstimatorError) as info:
        fuse(prior, [mesh], stature_mm=2500.0)
    assert info.value.code == "bad_stature"


def test_posterior_arrays_are_read_only() -> None:
    post = fuse(PRIOR, [observations_from_profile(profile_from_state(truth_state()))])
    assert isinstance(post, Posterior)
    with pytest.raises(ValueError):
        post.mean[0] = 0.0


def test_calibration_two_sigma_coverage() -> None:
    """Legs drawn from the prior, noise drawn from the declared model, partial captures."""
    rng = np.random.default_rng(20261111)
    chol = np.linalg.cholesky(PRIOR.cov)
    hits = total = 0
    for _ in range(200):
        x = PRIOR.mean + chol @ rng.standard_normal(N_STATE)
        source = ("mesh", "silhouette", "scale_free")[int(rng.integers(0, 3))]
        lo, hi = int(rng.integers(1, 6)), int(rng.integers(14, 20))
        ks = tuple(k for k in OBSERVABLE_K if lo <= k <= hi and rng.random() > 0.15)
        span = None if source == "mesh" else float(rng.uniform(40.0, 200.0))
        clean = observations_from_profile(profile_from_state(x, source, ks=ks, span=span))
        y = clean.y + np.linalg.cholesky(clean.noise_cov) @ rng.standard_normal(clean.rows)
        n = len(ks)
        noisy = SectionProfile(
            source=source,  # type: ignore[arg-type]
            leg_length_mm=float(np.exp(y[0])),
            t=tuple(float(GRID_T[k]) for k in ks),
            width_mm=tuple(float(v) for v in np.exp(y[1 : 1 + n])),
            depth_mm=tuple(float(v) for v in np.exp(y[1 + n :])),
            azimuth_span_deg=span,
        )
        post = fuse(PRIOR, [observations_from_profile(noisy)])
        sd = np.sqrt(np.diag(post.cov))[FIT_IDX]
        hits += int(np.sum(np.abs(post.mean[FIT_IDX] - x[FIT_IDX]) <= 2 * sd))
        total += len(FIT_IDX)
    coverage = hits / total
    assert 0.90 <= coverage <= 0.99


def test_leg_length_key_is_state_zero() -> None:
    assert state_index(LEG_LENGTH_KEY) == IDX_L


def test_error_codes_and_messages_carry_no_digits() -> None:
    from forms_pipeline.shape.errors import ESTIMATOR_CODES, PRIOR_CODES, PriorError

    for code in ESTIMATOR_CODES | PRIOR_CODES:
        assert not any(ch.isdigit() for ch in code)
    for cls in (EstimatorError, PriorError):
        assert not any(ch.isdigit() for ch in cls.USER_MESSAGE)
    assert EstimatorError("no such code").code == "internal"
    assert isinstance(EstimatorError("singular"), RuntimeError)
