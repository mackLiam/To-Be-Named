from __future__ import annotations

from collections.abc import Callable

import trimesh

from zells_pipeline.contract import MEASUREMENT_KEYS
from zells_pipeline.extraction.measure import extract_measurements

DIM_TOLERANCE_MM = 3.0  # polygon-approximation slack for a 64-sided ellipse


def test_extraction_returns_all_25_keys(frustum_mesh: trimesh.Trimesh) -> None:
    result = extract_measurements(frustum_mesh)
    assert set(result.values.keys()) == set(MEASUREMENT_KEYS)


def test_leg_length_matches_constructed_height(
    frustum_mesh: trimesh.Trimesh, frustum_height_mm: float
) -> None:
    result = extract_measurements(frustum_mesh)
    tolerance = frustum_height_mm * 0.02  # 2%
    assert abs(result.values["Leg_Length"] - frustum_height_mm) < tolerance


def test_slice_widths_match_constructed_taper(
    frustum_mesh: trimesh.Trimesh, ellipse_radii_at: Callable[[float], tuple[float, float]]
) -> None:
    result = extract_measurements(frustum_mesh)
    for slice_name, fraction in (("S1", 0.2), ("S2", 0.4), ("S3", 0.6), ("S4", 0.8)):
        expected_rx, expected_ry = ellipse_radii_at(fraction)
        assert abs(result.values[f"{slice_name}_OW"] - 2 * expected_rx) < DIM_TOLERANCE_MM
        assert abs(result.values[f"{slice_name}_OD"] - 2 * expected_ry) < DIM_TOLERANCE_MM


def test_inner_dims_sum_to_outer_width(frustum_mesh: trimesh.Trimesh) -> None:
    result = extract_measurements(frustum_mesh)
    for slice_name in ("S1", "S2", "S3", "S4"):
        isw = result.values[f"{slice_name}_ISW"]
        icw = result.values[f"{slice_name}_ICW"]
        ow = result.values[f"{slice_name}_OW"]
        assert abs((isw + icw) - ow) < 1e-6


def test_slice_ordering_s1_nearest_wide_end(frustum_mesh: trimesh.Trimesh) -> None:
    """S1 (20%) sits nearest the wide (constructed knee-analog) end, S4 (80%)
    nearest the narrow (ankle-analog) end -- see extraction/measure.py's module
    docstring for the documented orientation convention."""
    result = extract_measurements(frustum_mesh)
    v = result.values
    assert v["S1_OW"] > v["S2_OW"] > v["S3_OW"] > v["S4_OW"]
    assert v["S1_OD"] > v["S2_OD"] > v["S3_OD"] > v["S4_OD"]


def test_meters_scale_mesh_triggers_rescale_flag(
    frustum_mesh_meters: trimesh.Trimesh, frustum_height_mm: float
) -> None:
    result = extract_measurements(frustum_mesh_meters)
    assert result.needs_scale_confirmation is True
    tolerance = frustum_height_mm * 0.02
    assert abs(result.values["Leg_Length"] - frustum_height_mm) < tolerance


def test_millimeter_scale_mesh_does_not_trigger_rescale_flag(frustum_mesh: trimesh.Trimesh) -> None:
    result = extract_measurements(frustum_mesh)
    assert result.needs_scale_confirmation is False
