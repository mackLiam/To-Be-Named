"""shape/legmodel.py: the forms.leg-model v1 producer (docs/ESTIMATOR-V1.md 1, rule 11).

The shared fixture packages/shared/tests/fixtures/leg-model-v1/valid-python-output.json
is generated from the shipped prior mean by running this file:

    cd services/pipeline && .venv/bin/python tests/test_shape_legmodel.py
    pnpm -s prettier --write packages/shared/tests/fixtures/leg-model-v1/valid-python-output.json

and compared here as parsed JSON, never as bytes.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from forms_pipeline.shape.errors import EstimatorError
from forms_pipeline.shape.gate import FitAction
from forms_pipeline.shape.legmodel import leg_model
from forms_pipeline.shape.model import (
    ESTIMATOR_VERSION,
    GRID_T,
    LEG_LENGTH_KEY,
    N_STATE,
    SLICE_K,
    project,
    ring_extents,
    signed_area,
    state_from_mm,
)
from forms_pipeline.shape.prior import load_prior

contract = pytest.importorskip("forms_pipeline.shape.contract")

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/shared/tests/fixtures/leg-model-v1/valid-python-output.json"
)
TOP_KEYS = {
    "format",
    "version",
    "leg",
    "units",
    "frame",
    "estimator_version",
    "prior_version",
    "leg_length_mm",
    "rings",
    "fit_check",
    "fit_action",
}


def fixture_document() -> dict[str, Any]:
    prior = load_prior()
    return leg_model(
        prior.mean,
        leg="L",
        prior_version=prior.prior_version,
        fit_check="optional",
        fit_action=FitAction("tape", "S2_OD"),
    )


def varied_state() -> np.ndarray:
    t = GRID_T
    w = 64.0 + 38.0 * np.sin(np.pi * 0.85 * t) + 0.37
    d = 58.0 + 31.0 * np.sin(np.pi * 0.8 * t) + 0.21
    return state_from_mm(412.34, w, d)


def test_output_validates_through_parse_leg_model() -> None:
    for x, leg, check, action in (
        (load_prior().mean, "L", "none", None),
        (varied_state(), "R", "required", FitAction("stature")),
        (varied_state(), "L", "optional", FitAction("tape", LEG_LENGTH_KEY)),
    ):
        doc = leg_model(x, leg=leg, prior_version="0.1.0", fit_check=check, fit_action=action)
        parsed = contract.parse_leg_model(doc)
        assert parsed.leg == leg and parsed.fit_check == check
        assert set(doc) == TOP_KEYS
        assert doc["estimator_version"] == ESTIMATOR_VERSION


def test_ring_and_point_counts_and_orientation() -> None:
    doc = leg_model(
        varied_state(), leg="L", prior_version="0.1.0", fit_check="none", fit_action=None
    )
    assert len(doc["rings"]) == contract.LEG_MODEL_RING_COUNT == 21
    for k, ring in enumerate(doc["rings"]):
        assert set(ring) == {"t", "center", "crest", "points"}
        assert ring["t"] == round(k / 20, 2)
        assert abs(ring["t"] - k / 20) <= 1e-6
        assert ring["center"] == [0.0, 0.0]
        assert len(ring["points"]) == contract.LEG_MODEL_RING_POINTS == 48
        assert all(len(p) == 2 for p in ring["points"])
        assert signed_area(np.array(ring["points"])) > 0
        for p in ring["points"]:
            assert all(round(c, 1) == c for c in p)
            assert all(math.copysign(1.0, c) == 1.0 for c in p if c == 0.0)  # no -0.0


def test_slice_extents_equal_the_25_values() -> None:
    x = varied_state()
    values = project(x)
    doc = leg_model(x, leg="L", prior_version="0.1.0", fit_check="none", fit_action=None)
    for s, k in SLICE_K.items():
        ring = doc["rings"][k]
        assert ring["t"] == pytest.approx(GRID_T[k])
        ew, ed = ring_extents(np.array(ring["points"]))
        assert abs(ew - values[f"{s}_OW"]) <= 0.1 + 1e-9
        assert abs(ed - values[f"{s}_OD"]) <= 0.1 + 1e-9


def test_leg_length_equals_leg_length_value() -> None:
    x = varied_state()
    doc = leg_model(x, leg="L", prior_version="0.1.0", fit_check="none", fit_action=None)
    assert abs(doc["leg_length_mm"] - project(x)[LEG_LENGTH_KEY]) <= 0.05 + 1e-9
    assert doc["leg_length_mm"] == round(doc["leg_length_mm"], 1)


def test_crest_is_the_max_y_point() -> None:
    doc = leg_model(
        varied_state(), leg="R", prior_version="0.1.0", fit_check="none", fit_action=None
    )
    for ring in doc["rings"]:
        top = max(ring["points"], key=lambda p: p[1])
        assert ring["crest"] == top
        assert ring["crest"][0] == 0.0


def test_fit_action_is_null_iff_fit_check_is_none() -> None:
    x = varied_state()
    doc = leg_model(x, leg="L", prior_version="0.1.0", fit_check="none", fit_action=None)
    assert doc["fit_action"] is None
    doc = leg_model(
        x, leg="L", prior_version="0.1.0", fit_check="required", fit_action=FitAction("stature")
    )
    assert doc["fit_action"] == {"kind": "stature"}
    for check, action in (
        ("none", FitAction("tape", "S1_OW")),
        ("optional", None),
        ("required", None),
        ("fail", FitAction("tape", "S1_OW")),
        ("unknown", None),
    ):
        with pytest.raises(EstimatorError) as info:
            leg_model(x, leg="L", prior_version="0.1.0", fit_check=check, fit_action=action)
        assert info.value.code == "bad_fit_check"


@pytest.mark.parametrize(
    "x", [np.zeros(N_STATE - 1), np.full(N_STATE, np.nan), np.full((N_STATE, 1), 4.0)]
)
def test_bad_states_raise(x: np.ndarray) -> None:
    with pytest.raises(EstimatorError) as info:
        leg_model(x, leg="L", prior_version="0.1.0", fit_check="none", fit_action=None)
    assert info.value.code == "bad_state"
    assert not any(ch.isdigit() for ch in str(info.value))


@pytest.mark.parametrize(("length", "width"), [(140.0, 80.0), (610.0, 80.0), (400.0, 640.0)])
def test_documents_the_validator_would_reject_are_never_emitted(
    length: float, width: float
) -> None:
    x = state_from_mm(length, np.full(21, width), np.full(21, 70.0))
    with pytest.raises(EstimatorError) as info:
        leg_model(x, leg="L", prior_version="0.1.0", fit_check="none", fit_action=None)
    assert info.value.code == "invalid_leg_model"
    assert not any(ch.isdigit() for ch in str(info.value))


def test_bad_leg_raises() -> None:
    with pytest.raises(EstimatorError):
        leg_model(varied_state(), leg="X", prior_version="0.1.0", fit_check="none", fit_action=None)  # type: ignore[arg-type]


def test_no_sigma_or_provenance_in_output() -> None:
    text = json.dumps(fixture_document())
    for word in ("sigma", "source", "provenance", "observed", "mesh"):
        assert word not in text


def test_fixture_regenerates_and_matches() -> None:
    on_disk = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert on_disk == fixture_document()
    contract.parse_leg_model(on_disk)


if __name__ == "__main__":
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(fixture_document(), indent=2) + "\n", encoding="utf-8")
