from __future__ import annotations

import json
from pathlib import Path

import pytest
import trimesh
from conftest import make_tapered_frustum

from forms_pipeline.cad.profile import DEFAULT_PROFILE, apply_profile
from forms_pipeline.contract import MEASUREMENT_KEYS, SCHEMA_VERSION
from forms_pipeline.extract import cli
from forms_pipeline.extract.cli import EXIT_GATES_FAILED, EXIT_LOAD_OR_MEASURE_ERROR, EXIT_OK, main
from forms_pipeline.extraction.measure import EXTRACTION_VERSION, ExtractionResult

# Deliberately below the schema's Leg_Length minimum (150mm), so extraction
# succeeds (produces all 25 keys) but the Leg_Length gate fails. Radii are
# kept within the per-slice 30-220mm range so Leg_Length is the only failure.
GATE_FAIL_HEIGHT_MM = 50.0
GATE_FAIL_RADIUS_MM = 40.0


@pytest.fixture
def out_of_range_obj_path(tmp_path: Path) -> Path:
    mesh: trimesh.Trimesh = make_tapered_frustum(
        GATE_FAIL_HEIGHT_MM,
        GATE_FAIL_RADIUS_MM,
        GATE_FAIL_RADIUS_MM,
        GATE_FAIL_RADIUS_MM,
        GATE_FAIL_RADIUS_MM,
    )
    path = tmp_path / "out_of_range.obj"
    mesh.export(path)
    return path


def test_happy_path_table_output(frustum_obj_path: Path, capsys: pytest.CaptureFixture) -> None:
    exit_code = main([str(frustum_obj_path)])
    captured = capsys.readouterr()

    assert exit_code == EXIT_OK
    assert captured.err == ""
    assert "Leg_Length" in captured.out
    assert "S4_OD" in captured.out
    assert f"extraction_version: {EXTRACTION_VERSION}" in captured.out
    assert f"schema_version: {SCHEMA_VERSION}" in captured.out
    assert "needs_scale_confirmation: False" in captured.out
    assert "Gates: PASS" in captured.out
    assert "FAIL" not in captured.out


def test_happy_path_json_output(frustum_obj_path: Path, capsys: pytest.CaptureFixture) -> None:
    exit_code = main([str(frustum_obj_path), "--json"])
    captured = capsys.readouterr()

    assert exit_code == EXIT_OK
    assert captured.err == ""
    payload = json.loads(captured.out)

    assert set(payload["values"].keys()) == set(MEASUREMENT_KEYS)
    assert payload["extraction_version"] == EXTRACTION_VERSION
    assert payload["schema_version"] == SCHEMA_VERSION
    assert payload["needs_scale_confirmation"] is False
    assert payload["gates"] == {"passed": True, "failures": []}


def test_corrupt_file_exits_1_without_traceback(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    bad_path = tmp_path / "garbage.obj"
    bad_path.write_bytes(b"\x00\x01\x02not a wavefront obj at all\xff\xfe")

    exit_code = main([str(bad_path)])
    captured = capsys.readouterr()

    assert exit_code == EXIT_LOAD_OR_MEASURE_ERROR
    assert captured.out == ""
    assert captured.err.startswith("error:")
    assert "Traceback" not in captured.err


def test_missing_file_exits_1_without_traceback(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    missing_path = tmp_path / "does_not_exist.obj"

    exit_code = main([str(missing_path)])
    captured = capsys.readouterr()

    assert exit_code == EXIT_LOAD_OR_MEASURE_ERROR
    assert captured.out == ""
    assert "Traceback" not in captured.err


def test_gate_failure_exits_2_and_names_failing_key_table(
    out_of_range_obj_path: Path, capsys: pytest.CaptureFixture
) -> None:
    exit_code = main([str(out_of_range_obj_path)])
    captured = capsys.readouterr()

    assert exit_code == EXIT_GATES_FAILED
    assert "Gates: FAIL" in captured.out
    assert "FAIL  Leg_Length" in captured.out
    assert "PASS  S1_OW" in captured.out


def test_gate_failure_exits_2_and_names_failing_key_json(
    out_of_range_obj_path: Path, capsys: pytest.CaptureFixture
) -> None:
    exit_code = main([str(out_of_range_obj_path), "--json"])
    captured = capsys.readouterr()

    assert exit_code == EXIT_GATES_FAILED
    payload = json.loads(captured.out)

    assert payload["gates"]["passed"] is False
    assert any(f.startswith("Leg_Length:") for f in payload["gates"]["failures"])


def test_model_values_absent_without_flag(
    frustum_obj_path: Path, capsys: pytest.CaptureFixture
) -> None:
    main([str(frustum_obj_path)])
    assert "Model values" not in capsys.readouterr().out
    main([str(frustum_obj_path), "--json"])
    assert "model_values" not in json.loads(capsys.readouterr().out)


def test_model_values_json(frustum_obj_path: Path, capsys: pytest.CaptureFixture) -> None:
    exit_code = main([str(frustum_obj_path), "--json", "--model-values"])
    payload = json.loads(capsys.readouterr().out)

    assert exit_code == EXIT_OK
    assert payload["model_values"]["profile"] == "crest_spline_v1"
    model = payload["model_values"]["values"]
    assert model == apply_profile(payload["values"], DEFAULT_PROFILE)
    assert list(model) == list(MEASUREMENT_KEYS)
    # Normal output is unchanged by the flag.
    assert set(payload["values"]) == set(MEASUREMENT_KEYS)
    assert payload["gates"] == {"passed": True, "failures": []}


def test_model_values_table(frustum_obj_path: Path, capsys: pytest.CaptureFixture) -> None:
    main([str(frustum_obj_path), "--json"])
    leg = json.loads(capsys.readouterr().out)["values"]
    expected = apply_profile(leg, DEFAULT_PROFILE)

    exit_code = main([str(frustum_obj_path), "--model-values"])
    out = capsys.readouterr().out

    assert exit_code == EXIT_OK
    assert "Gates: PASS" in out
    _, header, model_section = out.partition("Model values (crest_spline_v1, mm):")
    assert header
    for key in MEASUREMENT_KEYS:
        assert f"{expected[key]:10.2f} mm" in model_section
        assert key in model_section


def test_model_values_profile_error_exits_1_without_traceback(
    frustum_obj_path: Path, capsys: pytest.CaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    values = {key: 100.0 for key in MEASUREMENT_KEYS}
    values["S2_OD"] = 0.0
    monkeypatch.setattr(
        cli,
        "extract_measurements",
        lambda _mesh: ExtractionResult(values=values, needs_scale_confirmation=False),
    )

    exit_code = main([str(frustum_obj_path), "--model-values"])
    captured = capsys.readouterr()

    assert exit_code == EXIT_LOAD_OR_MEASURE_ERROR
    assert captured.out == ""
    assert captured.err.startswith("error:")
    assert "S2_OD" in captured.err
    assert "Traceback" not in captured.err
