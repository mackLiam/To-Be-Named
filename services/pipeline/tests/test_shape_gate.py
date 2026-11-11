"""shape/gate.py: bands, exclusions, the best next action, ties, and the feasibility table.

Uses explicit tolerance and sigma fixtures, not the provisional defaults, except
where the default set itself is under test.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from types import MappingProxyType

import numpy as np
import pytest
from test_shape_model import synthetic_state
from test_shape_observe import profile_from_state
from test_shape_prior import stature_prior

from forms_pipeline.contract import MEASUREMENT_KEYS
from forms_pipeline.shape.fuse import PassThrough, Posterior, fuse, value_sigmas_mm
from forms_pipeline.shape.gate import (
    DEFAULT_TOLERANCES,
    FitAction,
    action_outcomes,
    best_action,
    evaluate,
    feasibility_table,
    verdict_for_ratio,
    worst_ratio,
)
from forms_pipeline.shape.model import (
    FIT_CRITICAL_KEYS,
    LEG_LENGTH_KEY,
    N_STATE,
    project,
    state_index,
)
from forms_pipeline.shape.observe import (
    MANUAL_KEYS,
    observations_from_manual,
    observations_from_profile,
)
from forms_pipeline.shape.prior import Prior, load_prior

PRIOR = load_prior()
# Explicit fixture tolerances (mm), deliberately unlike the provisional defaults.
TOL = MappingProxyType(
    {
        k: 20.0 if k == LEG_LENGTH_KEY else (8.0 if k.endswith("_OW") else 10.0)
        for k in FIT_CRITICAL_KEYS
    }
)
TEN = MappingProxyType(dict.fromkeys(FIT_CRITICAL_KEYS, 10.0))


def sigmas(value: float, **overrides: float) -> dict[str, float]:
    out = dict.fromkeys(MEASUREMENT_KEYS, value)
    out.update(overrides)
    return out


@pytest.mark.parametrize(
    ("r", "verdict"),
    [
        (0.0, "none"),
        (0.6, "none"),
        (math.nextafter(0.6, 1.0), "optional"),
        (1.0, "optional"),
        (math.nextafter(1.0, 2.0), "required"),
        (2.0, "required"),
        (math.nextafter(2.0, 3.0), "fail"),
        (math.inf, "fail"),
        (math.nan, "fail"),
        (-0.1, "fail"),
    ],
)
def test_band_boundaries_are_exact(r: float, verdict: str) -> None:
    assert verdict_for_ratio(r) == verdict


@pytest.mark.parametrize(
    ("sigma", "verdict"),
    [
        (3.0, "none"),
        (3.0000001, "optional"),
        (5.0, "optional"),
        (10.0, "required"),
        (10.0001, "fail"),
    ],
)
def test_band_boundaries_through_sigma_and_tolerance(sigma: float, verdict: str) -> None:
    r, key = worst_ratio(sigmas(1.0, S3_OD=sigma), frozenset(), TEN)
    assert key == "S3_OD"
    assert verdict_for_ratio(r) == verdict


def test_worst_ratio_uses_two_sigma_over_tolerance() -> None:
    r, key = worst_ratio(sigmas(1.0, S2_OW=3.0, Leg_Length=6.0), frozenset(), TOL)
    assert key == "S2_OW" and r == pytest.approx(2 * 3.0 / 8.0)
    r, key = worst_ratio(sigmas(1.0, Leg_Length=9.0), frozenset(), TOL)
    assert key == LEG_LENGTH_KEY and r == pytest.approx(2 * 9.0 / 20.0)


def test_pass_through_keys_are_excluded() -> None:
    big = sigmas(1.0, S2_OW=50.0)
    assert worst_ratio(big, frozenset(), TOL)[1] == "S2_OW"
    r, key = worst_ratio(big, frozenset({"S2_OW"}), TOL)
    assert key != "S2_OW" and r == pytest.approx(2 * 1.0 / 8.0)
    assert worst_ratio(big, frozenset(FIT_CRITICAL_KEYS), TOL) == (0.0, None)
    # Inner keys never count, however large.
    assert worst_ratio(sigmas(1.0, S1_ISW=500.0), frozenset(), TOL)[1] != "S1_ISW"


def test_missing_or_invalid_tolerance_is_a_fail_not_a_pass() -> None:
    partial = {k: v for k, v in TOL.items() if k != "S4_OD"}
    r, key = worst_ratio(sigmas(1.0), frozenset(), partial)
    assert math.isinf(r) and key == "S4_OD" and verdict_for_ratio(r) == "fail"
    for bad in (0.0, -1.0, math.nan):
        r, _ = worst_ratio(sigmas(1.0), frozenset(), {**TOL, "S1_OW": bad})
        assert verdict_for_ratio(r) == "fail"
    r, _ = worst_ratio(sigmas(1.0, S1_OD=math.nan), frozenset(), TOL)
    assert verdict_for_ratio(r) == "fail"


def test_default_tolerances_are_derived_by_suffix() -> None:
    assert set(DEFAULT_TOLERANCES) == set(FIT_CRITICAL_KEYS)
    assert DEFAULT_TOLERANCES[LEG_LENGTH_KEY] == 15.0
    assert all(DEFAULT_TOLERANCES[k] == 6.0 for k in FIT_CRITICAL_KEYS if k != LEG_LENGTH_KEY)


def _short_sweep_posterior(prior: Prior = PRIOR, stature_mm: float | None = None) -> Posterior:
    x = synthetic_state(leg_length_mm=390.0)
    obs = observations_from_profile(
        profile_from_state(x, "silhouette", ks=tuple(range(3, 14)), span=100.0)
    )
    return fuse(prior, [obs], stature_mm=stature_mm)


def _brute_force(
    post: Posterior, tolerances: Mapping[str, float]
) -> list[tuple[float, float, int, FitAction]]:
    """Every candidate by re-running fusion with the action's observation added."""
    rows = []
    current = {k: math.exp(post.mean[state_index(k)]) for k in FIT_CRITICAL_KEYS}
    for order, key in enumerate(MEASUREMENT_KEYS):
        if key not in FIT_CRITICAL_KEYS or key in post.pass_through:
            continue
        tape = observations_from_manual({key: current[key]}, adjusted=False)
        after = fuse(post.prior, [*post.observations, tape], post.stature_mm)
        sd = value_sigmas_mm(after)
        r, _ = worst_ratio(sd, frozenset(after.pass_through), tolerances)
        total = sum(value_sigmas_mm(post, after.cov)[k] ** 2 for k in FIT_CRITICAL_KEYS)
        rows.append((r, total, order, FitAction("tape", key)))
    if post.prior.has_covariate("stature_mm") and post.stature_mm is None:
        after = fuse(post.prior, list(post.observations), 1700.0)
        sd = value_sigmas_mm(post, after.cov)
        r, _ = worst_ratio(sd, frozenset(post.pass_through), tolerances)
        total = sum(sd[k] ** 2 for k in FIT_CRITICAL_KEYS)
        rows.append((r, total, len(MEASUREMENT_KEYS), FitAction("stature")))
    return rows


@pytest.mark.parametrize("with_stature", [False, True])
def test_chosen_action_is_the_brute_force_argmin(with_stature: bool) -> None:
    prior = stature_prior() if with_stature else PRIOR
    post = _short_sweep_posterior(prior)
    rows = _brute_force(post, TOL)
    assert len(rows) == 9 + int(with_stature)
    expected = min(rows, key=lambda row: (round(row[0], 9), round(row[1], 6), row[2]))[3]
    assert best_action(post, TOL) == expected
    outcomes = {a: r for a, r, _t, _o in action_outcomes(post, TOL)}
    for r, _total, _order, action in rows:
        assert outcomes[action] == pytest.approx(r, rel=1e-9)
    result = evaluate(post, TOL)
    assert result.verdict != "none" and result.action == expected


def test_typed_keys_are_not_candidates_and_typing_one_changes_the_choice() -> None:
    post = _short_sweep_posterior()
    first = best_action(post, TOL)
    assert first is not None and first.kind == "tape"
    typed = observations_from_manual({first.key: 90.0}, adjusted=False)  # type: ignore[dict-item]
    after = fuse(PRIOR, [*post.observations, typed])
    candidates = {a.key for a, *_ in action_outcomes(after, TOL)}
    assert first.key not in candidates and len(candidates) == 8


def _uniform_posterior() -> Posterior:
    """Diagonal covariance, every slice width and depth the same: all tape actions tie."""
    mean = np.full(N_STATE, math.log(80.0))
    mean[0] = math.log(380.0)
    cov = np.eye(N_STATE) * 0.05**2
    return Posterior(
        prior=PRIOR,
        observations=(),
        stature_mm=None,
        mean=mean,
        cov=cov,
        pass_through=MappingProxyType({LEG_LENGTH_KEY: PassThrough(380.0, "manual")}),
    )


def test_ties_are_deterministic() -> None:
    post = _uniform_posterior()
    outcomes = action_outcomes(post, TEN)
    assert len({round(r, 9) for _a, r, _t, _o in outcomes}) == 1
    assert len({round(t, 6) for _a, _r, t, _o in outcomes}) == 1
    first_in_key_order = next(k for k in MEASUREMENT_KEYS if k in FIT_CRITICAL_KEYS[1:])
    for _ in range(3):
        assert best_action(post, TEN) == FitAction("tape", first_in_key_order)


def test_prior_only_gives_fail() -> None:
    for tolerances in (TOL, DEFAULT_TOLERANCES):
        result = evaluate(fuse(PRIOR, []), tolerances)
        assert result.verdict == "fail"
        assert result.worst_key in FIT_CRITICAL_KEYS and result.worst_ratio > 2.0
        assert result.action is not None


def test_manual_only_passes_with_no_action() -> None:
    values = {k: v for k, v in project(synthetic_state()).items() if k in MANUAL_KEYS}
    result = evaluate(fuse(PRIOR, [observations_from_manual(values, adjusted=False)]), TOL)
    assert result.verdict == "none"
    assert result.worst_ratio == 0.0 and result.worst_key is None and result.action is None
    assert set(result.sigma_mm) == set(MEASUREMENT_KEYS)


def test_none_verdict_has_no_action_and_others_do() -> None:
    x = synthetic_state()
    mesh = fuse(PRIOR, [observations_from_profile(profile_from_state(x, "mesh"))])
    loose = MappingProxyType(dict.fromkeys(FIT_CRITICAL_KEYS, 100.0))
    assert evaluate(mesh, loose).verdict == "none" and evaluate(mesh, loose).action is None
    tight = MappingProxyType(dict.fromkeys(FIT_CRITICAL_KEYS, 4.0))
    result = evaluate(mesh, tight)
    assert result.verdict in ("optional", "required", "fail") and result.action is not None


def test_gate_never_raises() -> None:
    post = _uniform_posterior()
    broken = Posterior(
        prior=PRIOR,
        observations=(),
        stature_mm=None,
        mean=np.full(3, np.nan),
        cov=np.eye(3),
        pass_through=MappingProxyType({}),
    )
    result = evaluate(broken, TOL)
    assert result.verdict == "fail" and result.action is None
    assert evaluate(post, {}).verdict == "fail"


def test_fit_action_json() -> None:
    assert FitAction("tape", "S2_OD").to_json() == {"kind": "tape", "key": "S2_OD"}
    assert FitAction("stature").to_json() == {"kind": "stature"}


def test_feasibility_table_prior_only_fails() -> None:
    rows = {row.source_mix: row for row in feasibility_table(PRIOR)}
    assert rows["prior only"].verdict == "fail"
