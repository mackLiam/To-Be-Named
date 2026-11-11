"""Leg measurements to CAD model values (cad/profile.py, docs/DESIGN.md 12.2)."""

from __future__ import annotations

import math
from typing import Any

import pytest

from forms_pipeline.cad.model import CrestSplineV1Profile, IdentityProfile, Wrap
from forms_pipeline.cad.profile import (
    DEFAULT_PROFILE,
    DEFAULT_WRAP,
    LEG_LENGTH_KEY,
    ProfileError,
    apply_profile,
)
from forms_pipeline.contract import MEASUREMENT_KEYS, SCHEMA


def _leg_values(value: float = 100.0) -> dict[str, float]:
    return {key: value for key in MEASUREMENT_KEYS}


def _slices() -> list[str]:
    return sorted({key.split("_")[0] for key in MEASUREMENT_KEYS if key != LEG_LENGTH_KEY})


def test_default_wrap_constants() -> None:
    assert DEFAULT_WRAP == Wrap(inner_shin=0.35, inner_calf=0.6, outer=0.7)
    assert DEFAULT_PROFILE.kind == "crest_spline_v1"
    assert DEFAULT_PROFILE.wrap == DEFAULT_WRAP


def test_leg_length_key_is_derived_from_schema() -> None:
    assert LEG_LENGTH_KEY in MEASUREMENT_KEYS
    assert _slices() == ["S1", "S2", "S3", "S4"]


def test_crest_spline_matches_hand_computed_slice() -> None:
    # W = 100, D = 80: a = 50, b = 40.
    # ISW = 0.35 * 50 = 17.5; ISD = 40 * (1 - sqrt(1 - 0.35^2)) = 2.5300...
    # ICW = 0.6 * 50 = 30;    ICD = 40 * (1 - sqrt(1 - 0.36)) = 40 * 0.2 = 8
    # OW = 0.7 * 50 = 35;     OD = 40 * (1 - sqrt(1 - 0.49)) = 11.4343...
    values = _leg_values()
    values["S1_OW"] = 100.0
    values["S1_OD"] = 80.0
    values[LEG_LENGTH_KEY] = 412.345

    out = apply_profile(values, DEFAULT_PROFILE)

    assert out["S1_ISW"] == 17.5
    assert out["S1_ISD"] == 2.53
    assert out["S1_ICW"] == 30.0
    assert out["S1_ICD"] == 8.0
    assert out["S1_OW"] == 35.0
    assert out["S1_OD"] == 11.43
    assert out[LEG_LENGTH_KEY] == 412.35


def test_crest_spline_ignores_leg_half_split_inputs() -> None:
    # v1 uses only OW/OD per slice; changing the medial/lateral split inputs
    # must not move the model values.
    base = apply_profile(_leg_values(), DEFAULT_PROFILE)
    values = _leg_values()
    for s in _slices():
        for dim in ("ISW", "ISD", "ICW", "ICD"):
            values[f"{s}_{dim}"] = 55.5
    assert apply_profile(values, DEFAULT_PROFILE) == base


def test_crest_spline_output_has_exactly_the_25_keys() -> None:
    out = apply_profile(_leg_values(), DEFAULT_PROFILE)
    assert list(out) == list(MEASUREMENT_KEYS)


def _schema_bound(key: str, bound: str) -> float:
    return float(SCHEMA["properties"][key][bound])


@pytest.mark.parametrize("bound", ["minimum", "maximum"])
@pytest.mark.parametrize(
    "wrap",
    [
        DEFAULT_WRAP,
        Wrap(inner_shin=0.2, inner_calf=0.3, outer=0.25),
        Wrap(inner_shin=0.9, inner_calf=0.95, outer=0.95),
    ],
)
def test_crest_spline_monotone_finite_positive(bound: str, wrap: Wrap) -> None:
    values = {key: _schema_bound(key, bound) for key in MEASUREMENT_KEYS}
    profile = CrestSplineV1Profile(kind="crest_spline_v1", wrap=wrap)

    out = apply_profile(values, profile)

    for key, value in out.items():
        assert math.isfinite(value), key
        assert value > 0, key
    for s in _slices():
        assert out[f"{s}_ISW"] < out[f"{s}_ICW"]
        assert out[f"{s}_ISD"] < out[f"{s}_ICD"]
        # A model point never reaches past the leg's own half-width or depth.
        assert out[f"{s}_ICW"] < values[f"{s}_OW"] / 2
        assert out[f"{s}_OW"] < values[f"{s}_OW"] / 2
        assert out[f"{s}_OD"] < values[f"{s}_OD"] / 2


def test_identity_returns_unchanged_copy() -> None:
    values = _leg_values()
    values["S3_ICD"] = 77.7
    out = apply_profile(values, IdentityProfile(kind="identity"))
    assert out == values
    assert out is not values
    out["S3_ICD"] = 1.0
    assert values["S3_ICD"] == 77.7


def test_does_not_mutate_input() -> None:
    values = _leg_values()
    snapshot = dict(values)
    apply_profile(values, DEFAULT_PROFILE)
    assert values == snapshot


@pytest.mark.parametrize("key", ["S2_OW", "S4_OD", LEG_LENGTH_KEY])
def test_missing_input_raises_profile_error_naming_key(key: str) -> None:
    values = _leg_values()
    del values[key]
    with pytest.raises(ProfileError, match=key):
        apply_profile(values, DEFAULT_PROFILE)


@pytest.mark.parametrize("key", ["S1_OW", "S3_OD", LEG_LENGTH_KEY])
@pytest.mark.parametrize(
    "bad", [0.0, -12.5, float("nan"), float("inf"), -float("inf"), True, "100", None]
)
def test_bad_input_raises_profile_error_naming_key_not_value(key: str, bad: Any) -> None:
    values: dict[str, Any] = _leg_values()
    values[key] = bad
    with pytest.raises(ProfileError) as excinfo:
        apply_profile(values, DEFAULT_PROFILE)
    message = str(excinfo.value)
    assert key in message
    # Values are minors' body data and must never reach pipeline_jobs.error.
    assert repr(bad) not in message
    assert str(bad) not in message.replace(key, "")


def test_unused_half_split_inputs_are_not_validated() -> None:
    # Only the inputs v1 reads are required; a missing ISW does not fail.
    values = _leg_values()
    del values["S1_ISW"]
    out = apply_profile(values, DEFAULT_PROFILE)
    assert "S1_ISW" in out


def test_profile_error_is_value_error() -> None:
    assert issubclass(ProfileError, ValueError)
