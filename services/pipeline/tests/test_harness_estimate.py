"""The harness's report-only estimator stage on a synthetic video bundle.

Ratio tolerance. The posterior is the raw (extracted) measurement shrunk toward
the provisional prior's mean shape, so a posterior ratio's distance from the
truth is bounded by the raw ratio's own harness tolerance (test_harness_run:
0.008 per slice, 0.025 for Leg_Length/OW_S3) plus the shrink fraction times the
prior's own distance from the truth. The shipped prior 0.1.1's mean is
extraction on this truth leg (ESTIMATOR-V1 3), so the prior term vanishes and
the posterior must sit within the raw tolerance alone. Observed 2026-11-11 on
this bundle (12 keyframes, 143 degree span): largest |post - truth| 0.0037 per
slice (S1 OW/OW_S3), 0.0149 for Leg_Length/OW_S3.

Shrink. A prior equal to the truth cannot show that the capture's shape
dominates, so that check runs the same bundle against the superseded prior
0.1.0, whose OD/OW sits 0.19 to 0.31 above this truth (OW from the semi-axis
across the leg). Observed 2026-11-11: the largest shrink fraction is 0.056
(S1 OW/OW_S3); SHRINK_MAX = 0.1 gives about 1.8x headroom.
"""

from __future__ import annotations

import functools
import json
from pathlib import Path

import pytest
import trimesh
from harness_synth import scene, write_bundle
from test_silhouette import truth_mesh, truth_values

from forms_pipeline.harness import estimate as est
from forms_pipeline.harness import run
from forms_pipeline.shape.errors import EstimatorError
from forms_pipeline.shape.model import FIT_CRITICAL_KEYS, project
from forms_pipeline.shape.prior import load_prior

SLICE_RATIO_TOL = 0.008
LEG_RATIO_TOL = 0.025
SHRINK_MAX = 0.1
FAR_PRIOR = "0.1.0"
PRIOR_TRUTH_TOL = 1e-4  # the shipped mean is frozen to 6 decimals in log
ROUNDING = 1e-3  # the row's floats are rounded to 4 decimals
OPTIONS = run.Options(max_keyframes=12)
VERDICTS = ("none", "optional", "required", "fail")
RATIO_KEYS = {
    *(f"S{i} {r}" for i in range(1, 5) for r in ("OD/OW", "OW/OW_S3")),
    "Leg_Length/OW_S3",
}


@functools.lru_cache
def truth_ratios() -> dict[str, float]:
    return est.report_ratios(truth_values())


@functools.lru_cache
def prior_ratios(prior_version: str) -> dict[str, float]:
    return est.report_ratios(project(load_prior(prior_version).mean))


@pytest.fixture(scope="module")
def row(tmp_path_factory: pytest.TempPathFactory) -> dict:
    root = tmp_path_factory.mktemp("est")
    return run.analyze_bundle(write_bundle(root / "plain", scene()), root / "out", OPTIONS)


@pytest.fixture(scope="module")
def far_prior_row(tmp_path_factory: pytest.TempPathFactory) -> dict:
    root = tmp_path_factory.mktemp("est_far")
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(est, "PRIOR_VERSION", FAR_PRIOR)
        return run.analyze_bundle(write_bundle(root / "plain", scene()), root / "out", OPTIONS)


def _assert_gate_fields(section: dict) -> None:
    assert section["verdict"] in VERDICTS
    assert section["worst_key"] is None or section["worst_key"] in FIT_CRITICAL_KEYS
    assert section["r"] is None or (isinstance(section["r"], float) and section["r"] >= 0)
    action = section["best_action"]
    assert action is None or action["kind"] in ("tape", "stature")
    if action and action["kind"] == "tape":
        assert action["key"] in FIT_CRITICAL_KEYS


def test_estimator_runs_on_a_successful_row(row: dict) -> None:
    assert row["status"] == "ok", row
    e = row["estimator"]
    assert e["status"] == "ok" and e["reason"] is None
    assert e["provisional"] is True and e["prior_provisional"] is True
    assert (e["prior_version"], e["source"], e["stature"]) == ("0.1.1", "scale_free", None)
    assert e["azimuth_span_deg"] == row["silhouette"]["azimuth_span_deg"]
    assert 4 <= e["heights_observed"] <= e["heights_observable"] == 19
    _assert_gate_fields(e)
    _assert_gate_fields(e["what_if_tape_Leg_Length"])
    assert set(e["raw_ratios"]) == set(e["posterior_ratios"]) == RATIO_KEYS
    assert set(e["ratio_change_from_raw"]) == RATIO_KEYS
    assert set(e["relative_sigma"]) == set(FIT_CRITICAL_KEYS)
    assert set(e["r_after_action"]) == set(FIT_CRITICAL_KEYS)  # no stature in prior 0.1.1
    json.dumps(row)


def test_raw_ratios_are_the_rows_extracted_ratios(row: dict) -> None:
    e, slices = row["estimator"], row["metrics"]["slices"]
    for s, dims in slices.items():
        assert e["raw_ratios"][f"{s} OD/OW"] == pytest.approx(dims["OD/OW"], abs=ROUNDING)
        assert e["raw_ratios"][f"{s} OW/OW_S3"] == pytest.approx(dims["OW/OW_S3"], abs=ROUNDING)
    leg = row["metrics"]["Leg_Length/OW_S3"]
    assert e["raw_ratios"]["Leg_Length/OW_S3"] == pytest.approx(leg, abs=ROUNDING)


def test_posterior_ratios_stay_near_the_truth(row: dict) -> None:
    e, truth, prior = row["estimator"], truth_ratios(), prior_ratios(est.PRIOR_VERSION)
    for key in RATIO_KEYS:
        raw, post = e["raw_ratios"][key], e["posterior_ratios"][key]
        assert e["ratio_change_from_raw"][key] == pytest.approx(post - raw, abs=ROUNDING)
        assert abs(prior[key] - truth[key]) <= PRIOR_TRUTH_TOL, key
        raw_tol = LEG_RATIO_TOL if key.startswith("Leg_Length") else SLICE_RATIO_TOL
        assert abs(post - truth[key]) <= raw_tol, key


def test_capture_shape_dominates_a_far_prior(far_prior_row: dict) -> None:
    e, truth, prior = far_prior_row["estimator"], truth_ratios(), prior_ratios(FAR_PRIOR)
    assert e["status"] == "ok" and e["prior_version"] == FAR_PRIOR
    assert max(abs(prior[f"S{i} OD/OW"] - truth[f"S{i} OD/OW"]) for i in range(1, 5)) > 0.15
    for key in RATIO_KEYS:
        raw, post = e["raw_ratios"][key], e["posterior_ratios"][key]
        assert abs(post - raw) <= SHRINK_MAX * abs(prior[key] - raw) + ROUNDING, key
        raw_tol = LEG_RATIO_TOL if key.startswith("Leg_Length") else SLICE_RATIO_TOL
        assert abs(post - truth[key]) <= raw_tol + SHRINK_MAX * abs(prior[key] - truth[key]), key


def test_scale_free_capture_fails_and_asks_for_tape_leg_length(row: dict) -> None:
    """scale_log_sigma 1.0 leaves the size to the prior (level sigma 0.35 in log), so
    every key carries about 30% relative sigma and r far exceeds 2. Any one tape fixes
    the shared scale; the gate picks Leg_Length, whose r is the smallest after it."""
    e = row["estimator"]
    assert e["verdict"] == "fail" and e["r"] > 2.0
    assert e["best_action"] == {"kind": "tape", "key": "Leg_Length"}
    assert min(e["r_after_action"], key=e["r_after_action"].__getitem__) == "Leg_Length"
    assert all(0.2 < s < 0.5 for s in e["relative_sigma"].values())


def test_hypothetical_tape_leg_length_tightens_every_key(row: dict) -> None:
    e = row["estimator"]
    w = e["what_if_tape_Leg_Length"]
    assert w["hypothetical"] is True
    assert w["worst_key"] != "Leg_Length"  # a typed key is not gated by sigma
    assert w["r"] == pytest.approx(e["r_after_action"]["Leg_Length"], abs=ROUNDING)
    assert w["verdict"] != "fail" and w["r"] < e["r"]
    for key, sigma in w["relative_sigma"].items():
        assert sigma < e["relative_sigma"][key] / 5, key


def test_markdown_labels_everything_provisional_and_nominal(row: dict) -> None:
    md = run.render_markdown([row], [])
    section = md[md.index(est.HEADING) :]
    assert f"### {est.HEADING}" in md
    for phrase in ("Provisional prior 0.1.1", "provisional noise and tolerances",
                   "r (nominal scale)", "nothing here is a real size",
                   "Hypothetical, not a measurement", "(nominal value)",
                   "never changes the row's pass or fail"):  # fmt: skip
        assert phrase in section, phrase
    assert "| best next action | tape Leg_Length |" in section
    nominal = row["estimator"]["what_if_tape_Leg_Length"]["nominal_tape_Leg_Length_mm"]
    assert f"{nominal:.1f}" not in section and f"{nominal:.0f}" not in section
    assert " mm" not in section
    assert "\u2014" not in md and "\u2013" not in md


def test_forced_estimator_error_is_recorded_and_the_row_passes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def singular(*_args: object, **_kwargs: object) -> None:
        raise EstimatorError("singular")

    monkeypatch.setattr(est, "fuse", singular)
    failed = run.analyze_bundle(write_bundle(tmp_path / "b", scene()), tmp_path / "out", OPTIONS)
    assert failed["status"] == "ok" and failed["stage"] is None and failed["reason"] is None
    assert failed["metrics"] and failed["gate_at_nominal_scale"] is None
    e = failed["estimator"]
    assert e == {
        "status": "failed",
        "reason": EstimatorError.USER_MESSAGE,
        "code": "singular",
        "provisional": True,
    }
    run.write_results([failed], tmp_path / "res")
    payload = json.loads((tmp_path / "res/results.json").read_text())
    assert payload["rows"][0]["estimator"]["code"] == "singular"
    md = (tmp_path / "res/results.md").read_text()
    assert f"### {est.HEADING}" in md
    assert f"Estimator failed (singular): {EstimatorError.USER_MESSAGE}" in md
    assert "| b | ok | - | - |" in md


def test_unexpected_error_records_its_type_only(monkeypatch: pytest.MonkeyPatch) -> None:
    def leaky(*_args: object, **_kwargs: object) -> None:
        raise ValueError("S3_OW is 123.4 mm")

    monkeypatch.setattr(est, "section_profile_from_mesh", leaky)
    e = est.estimator_stage(trimesh.Trimesh(), 150.0, truth_values())
    assert e["status"] == "failed" and e["code"] == "unexpected"
    assert e["reason"] == "Unexpected ValueError." and "123.4" not in json.dumps(e)


def test_report_on_the_truth_mesh_without_a_span() -> None:
    """No span means worst-case depth sigma; the report still forms on a measured mesh."""
    mesh_mm = truth_mesh().apply_scale(1000.0)
    e = est.estimator_report(mesh_mm, None, truth_values())
    assert e["azimuth_span_deg"] is None and e["heights_observed"] == 19
    _assert_gate_fields(e)
    for key, value in e["raw_ratios"].items():
        assert value == pytest.approx(truth_ratios()[key])
