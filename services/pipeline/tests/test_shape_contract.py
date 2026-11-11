"""forms.leg-model v1 and forms.measurement-quality v1 against the shared fixtures."""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path
from typing import Any

import pytest

from forms_pipeline.contract import MEASUREMENT_KEYS, SCHEMA
from forms_pipeline.shape.contract import (
    LegModelError,
    MeasurementQualityError,
    parse_leg_model,
    parse_measurement_quality,
)

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "shared" / "tests" / "fixtures"
LEG_DIR = FIXTURES / "leg-model-v1"
Q_DIR = FIXTURES / "measurement-quality-v1"


def _cases(directory: Path) -> list[Path]:
    return sorted(p for p in directory.glob("*.json") if p.name.startswith(("valid-", "invalid-")))


def _load(directory: Path, name: str) -> dict[str, Any]:
    return json.loads((directory / name).read_text())


def _leg() -> dict[str, Any]:
    return _load(LEG_DIR, "valid-optional-tape.json")


def _quality() -> dict[str, Any]:
    return _load(Q_DIR, "valid-optional-tape.json")


@pytest.mark.parametrize("path", _cases(LEG_DIR), ids=lambda p: p.name)
def test_leg_model_fixture(path: Path) -> None:
    data = json.loads(path.read_text())
    if path.name.startswith("valid-"):
        parse_leg_model(data)
    else:
        with pytest.raises(LegModelError):
            parse_leg_model(data)


@pytest.mark.parametrize("path", _cases(Q_DIR), ids=lambda p: p.name)
def test_quality_fixture(path: Path) -> None:
    data = json.loads(path.read_text())
    if path.name.startswith("valid-"):
        parse_measurement_quality(data)
    else:
        with pytest.raises(MeasurementQualityError):
            parse_measurement_quality(data)


def test_fixture_counts() -> None:
    for directory in (LEG_DIR, Q_DIR):
        names = [p.name for p in _cases(directory)]
        assert sum(n.startswith("valid-") for n in names) >= 2
        assert sum(n.startswith("invalid-") for n in names) >= 10


def test_errors_are_value_errors() -> None:
    assert issubclass(LegModelError, ValueError)
    assert issubclass(MeasurementQualityError, ValueError)


def test_leg_parse_returns_frozen_model() -> None:
    model = parse_leg_model(_leg())
    assert model.leg == "L"
    assert len(model.rings) == 21
    with pytest.raises(Exception):  # noqa: B017, PT011
        model.leg = "R"  # type: ignore[misc]


def _leg_fails(mutate: Any) -> LegModelError:
    data = _leg()
    mutate(data)
    with pytest.raises(LegModelError) as info:
        parse_leg_model(data)
    return info.value


def test_leg_unknown_keys_at_every_level() -> None:
    _leg_fails(lambda d: d.__setitem__("sigma", 1))
    _leg_fails(lambda d: d["rings"][0].__setitem__("extra", 1))
    _leg_fails(lambda d: d["fit_action"].__setitem__("extra", 1))


def test_leg_header_rules() -> None:
    for key, value in [
        ("format", "x"),
        ("version", 2),
        ("version", True),
        ("leg", "B"),
        ("units", "m"),
        ("frame", "x"),
        ("estimator_version", "1.0"),
        ("prior_version", "a.b.c"),
    ]:
        _leg_fails(lambda d, k=key, v=value: d.__setitem__(k, v))


def test_leg_length_bounds_come_from_schema() -> None:
    spec = SCHEMA["properties"]["Leg_Length"]
    for value in (spec["minimum"] - 0.1, spec["maximum"] + 0.1, "380", True):
        _leg_fails(lambda d, v=value: d.__setitem__("leg_length_mm", v))
    for value in (spec["minimum"], spec["maximum"]):
        data = _leg()
        data["leg_length_mm"] = value
        parse_leg_model(data)


def test_leg_ring_rules() -> None:
    _leg_fails(lambda d: d["rings"].pop())
    _leg_fails(lambda d: d["rings"][1]["points"].pop())
    _leg_fails(lambda d: d["rings"][4].__setitem__("t", 0.2 + 2e-6))
    data = _leg()
    data["rings"][4]["t"] = 0.2 + 5e-7
    parse_leg_model(data)
    _leg_fails(lambda d: d["rings"][2]["points"].reverse())
    _leg_fails(lambda d: d["rings"][2].__setitem__("crest", [301.0, 0.0]))
    _leg_fails(lambda d: d["rings"][2].__setitem__("center", [0.0, 1.0, 2.0]))
    _leg_fails(lambda d: d["rings"][2].__setitem__("center", [math.inf, 0.0]))
    data = _leg()
    data["rings"][2]["points"][0] = [300.0, 0.0]
    parse_leg_model(data)


def test_leg_fit_action_rules() -> None:
    _leg_fails(lambda d: d.__setitem__("fit_check", "none"))
    _leg_fails(lambda d: d.__setitem__("fit_action", None))
    _leg_fails(lambda d: d.__setitem__("fit_check", "fail"))
    _leg_fails(lambda d: d.pop("fit_action"))
    for action in (
        {"kind": "tape", "key": "S1_ISW"},
        {"kind": "tape", "key": "S5_OW"},
        {"kind": "tape"},
        {"kind": "stature", "key": "S1_OW"},
        {"kind": "scan"},
    ):
        _leg_fails(lambda d, a=action: d.__setitem__("fit_action", a))
    for action in ({"kind": "stature"}, {"kind": "tape", "key": "Leg_Length"}):
        data = _leg()
        data["fit_action"] = action
        parse_leg_model(data)
    data = _leg()
    data["fit_check"], data["fit_action"] = "none", None
    parse_leg_model(data)


def test_leg_error_names_fields_not_values() -> None:
    err = _leg_fails(lambda d: d.__setitem__("leg_length_mm", 98765.4321))
    assert "leg_length_mm" in str(err)
    assert "98765" not in str(err)
    err = _leg_fails(lambda d: d["rings"][0]["points"].__setitem__(0, [301.5, 7.25]))
    assert "rings.0.points" in str(err)
    assert "301.5" not in str(err)
    assert "7.25" not in str(err)


def _quality_fails(mutate: Any) -> MeasurementQualityError:
    data = _quality()
    mutate(data)
    with pytest.raises(MeasurementQualityError) as info:
        parse_measurement_quality(data)
    return info.value


def test_quality_parse_returns_model() -> None:
    model = parse_measurement_quality(_quality())
    assert set(model.values) == set(MEASUREMENT_KEYS)
    assert model.verdict == "optional"


def test_quality_unknown_keys_at_every_level() -> None:
    _quality_fails(lambda d: d.__setitem__("extra", 1))
    _quality_fails(lambda d: d["values"]["S1_OW"].__setitem__("extra", 1))
    _quality_fails(lambda d: d["action"].__setitem__("extra", 1))


def test_quality_values_rules() -> None:
    _quality_fails(lambda d: d["values"].pop("S3_ICW"))
    _quality_fails(
        lambda d: d["values"].__setitem__("S9_OW", {"source": "observed", "sigma_mm": 1})
    )
    _quality_fails(lambda d: d["values"]["S1_OW"].__setitem__("source", "scan"))
    for sigma in (0, -1.0, 1000.01, math.nan, "3", True):
        _quality_fails(lambda d, s=sigma: d["values"]["S1_OW"].__setitem__("sigma_mm", s))
    data = _quality()
    data["values"]["S1_OW"]["sigma_mm"] = 1000.0
    parse_measurement_quality(data)


def test_quality_header_verdict_ratio() -> None:
    for key, value in [
        ("format", "x"),
        ("version", 2),
        ("verdict", "fail"),
        ("worst_ratio", -0.1),
    ]:
        _quality_fails(lambda d, k=key, v=value: d.__setitem__(k, v))


def test_quality_worst_key_rules() -> None:
    _quality_fails(lambda d: d.__setitem__("worst_key", None))
    _quality_fails(lambda d: d.__setitem__("worst_ratio", 0.0))
    _quality_fails(lambda d: d.__setitem__("worst_key", "S1_ISW"))
    data = _quality()
    data["worst_ratio"], data["worst_key"] = 0.0, None
    parse_measurement_quality(data)


def test_quality_tolerance_rules() -> None:
    _quality_fails(lambda d: d["tolerances_mm"].__setitem__("S9_OW", 6.0))
    _quality_fails(lambda d: d["tolerances_mm"].__setitem__("S1_OW", 0))


def test_quality_action_rules() -> None:
    _quality_fails(lambda d: d.__setitem__("verdict", "none"))
    _quality_fails(lambda d: d.__setitem__("action", None))
    _quality_fails(lambda d: d.__setitem__("action", {"kind": "tape", "key": "S1_ISW"}))
    data = copy.deepcopy(_quality())
    data["verdict"], data["action"] = "none", None
    parse_measurement_quality(data)


def test_quality_error_names_fields_not_values() -> None:
    err = _quality_fails(lambda d: d["values"]["S1_OW"].__setitem__("sigma_mm", -987.654))
    assert "values.S1_OW.sigma_mm" in str(err)
    assert "987" not in str(err)
