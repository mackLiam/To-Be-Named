from __future__ import annotations

import io

import numpy as np
import pytest
import trimesh
from test_reconstruct_synthetic import (
    ANKLE_Y,
    EXPECTED_LEG_LENGTH_MM,
    KNEE_Y,
    LEG_CENTER_XZ,
    LEG_PROFILE,
    NO_KNEE_PROFILE,
    camera_arc,
    camera_ring,
    make_leg_scene,
)

from forms_pipeline.contract import SCHEMA
from forms_pipeline.extraction.measure import extract_measurements
from forms_pipeline.reconstruct import ReconstructionQualityError
from forms_pipeline.reconstruct.handler import export_obj_mm
from forms_pipeline.reconstruct.segment import (
    AXIS_ANCHOR,
    AXIS_CIRCLE_FIT,
    BACK_COVERAGE_MIN_SPAN_DEG,
    LEG_LENGTH_KEY,
    LEG_LENGTH_MAX_MM,
    LEG_LENGTH_MIN_MM,
    MIN_CIRCLE_ARC_DEG,
    ORBIT_RADIUS_M,
    angular_span_deg,
    fit_circle,
    floor_height,
    meters_to_mm,
    orbit_center,
    segment_leg,
    slice_spans_deg,
)

CAMERAS = np.array([m[:3, 3] for m in camera_ring().values()])
ANCHOR = np.array([LEG_CENTER_XZ[0], 0.30, LEG_CENTER_XZ[1]])
ANKLE_R, CALF_R = LEG_PROFILE[1][1], LEG_PROFILE[2][1]


def _positions(cams: dict[str, np.ndarray]) -> np.ndarray:
    return np.array([m[:3, 3] for m in cams.values()])


def test_leg_length_range_comes_from_schema() -> None:
    spec = SCHEMA["properties"][LEG_LENGTH_KEY]
    assert (LEG_LENGTH_MIN_MM, LEG_LENGTH_MAX_MM) == (spec["minimum"], spec["maximum"])


def test_orbit_center_is_circle_center() -> None:
    assert np.allclose(orbit_center(CAMERAS[:, [0, 2]]), LEG_CENTER_XZ, atol=1e-9)


def test_orbit_center_rejects_collinear_cameras() -> None:
    line = np.column_stack([np.linspace(0, 1, 20), np.zeros(20)])
    with pytest.raises(ReconstructionQualityError):
        orbit_center(line)


def test_floor_height_finds_dense_bottom_band_or_none() -> None:
    y = np.concatenate([np.zeros(1000), np.linspace(0.02, 0.6, 500)])
    assert floor_height(y) == pytest.approx(0.0, abs=0.005)
    assert floor_height(np.concatenate([np.linspace(0.0, 0.3, 50), np.full(1000, 0.3)])) is None


def test_segments_ankle_to_knee_and_drops_floor_foot_background() -> None:
    seg = segment_leg(make_leg_scene(), CAMERAS)

    lo, hi = seg.mesh.bounds
    assert lo[1] == pytest.approx(ANKLE_Y, abs=0.01)
    assert hi[1] == pytest.approx(KNEE_Y, abs=0.01)
    radial = np.hypot(seg.mesh.vertices[:, 0] - LEG_CENTER_XZ[0],
                      seg.mesh.vertices[:, 2] - LEG_CENTER_XZ[1])  # fmt: skip
    assert radial.max() < 0.07  # tube only: no foot, floor or background box
    assert seg.confidence["ankle_found"] and seg.confidence["knee_found"]
    assert seg.confidence["floor_found"]


def test_segment_without_floor_still_works() -> None:
    seg = segment_leg(make_leg_scene(floor=False), CAMERAS)
    assert seg.mesh.bounds[0, 1] == pytest.approx(ANKLE_Y, abs=0.01)


def test_background_outside_radius_is_ignored() -> None:
    assert ORBIT_RADIUS_M < 0.32 - 0.05  # the synthetic background box sits beyond it
    seg = segment_leg(make_leg_scene(), CAMERAS)
    assert seg.mesh.bounds[1, 0] < LEG_CENTER_XZ[0] + 0.1


def test_no_ankle_is_rescan() -> None:
    cylinder = make_leg_scene(profile=((0.0, 0.05), (0.6, 0.05)), foot=False, floor=False)
    with pytest.raises(ReconstructionQualityError, match="ankle"):
        segment_leg(cylinder, CAMERAS)


def test_no_knee_is_rescan() -> None:
    with pytest.raises(ReconstructionQualityError, match="knee"):
        segment_leg(make_leg_scene(profile=NO_KNEE_PROFILE), CAMERAS)


def test_nothing_inside_orbit_is_rescan() -> None:
    far = trimesh.creation.box(extents=(0.1, 0.1, 0.1))
    far.apply_translation((5.0, 0.0, 5.0))
    with pytest.raises(ReconstructionQualityError, match="No leg"):
        segment_leg(far, CAMERAS)


def test_meters_to_mm_is_the_single_mesh_conversion() -> None:
    assert meters_to_mm(0.25) == 250.0
    assert np.allclose(meters_to_mm(np.array([0.001, 1.0])), [1.0, 1000.0])


def test_exported_mm_obj_measures_without_unit_guessing() -> None:
    seg = segment_leg(make_leg_scene(), CAMERAS)
    mesh = trimesh.load(io.BytesIO(export_obj_mm(seg.mesh)), file_type="obj", process=False)

    result = extract_measurements(mesh)

    assert result.needs_scale_confirmation is False  # bbox reads as mm, not meters
    assert result.values[LEG_LENGTH_KEY] == pytest.approx(EXPECTED_LEG_LENGTH_MM, abs=12)


def test_angular_span_is_360_minus_largest_gap() -> None:
    a = np.radians([0.0, 90.0, 180.0])
    xz = np.column_stack([np.cos(a), np.sin(a)])
    assert angular_span_deg(xz, np.zeros(2)) == pytest.approx(180.0)
    assert angular_span_deg(xz[:1], np.zeros(2)) == 0.0
    ring = np.radians(np.arange(0.0, 360.0, 10.0))
    assert angular_span_deg(np.column_stack([np.cos(ring), np.sin(ring)]), np.zeros(2)) == (
        pytest.approx(350.0)
    )


def test_legacy_full_orbit_uses_circle_fit_with_full_coverage() -> None:
    seg = segment_leg(make_leg_scene(), CAMERAS)
    assert seg.confidence["axis_source"] == AXIS_CIRCLE_FIT
    assert seg.confidence["span_min_deg"] > 350.0
    assert seg.confidence["back_coverage_low"] is False


@pytest.mark.parametrize("span_deg", [90.0, 150.0, MIN_CIRCLE_ARC_DEG - 10])
def test_circle_fit_on_partial_arc_is_rescan(span_deg: float) -> None:
    with pytest.raises(ReconstructionQualityError, match="did not circle the leg"):
        orbit_center(_positions(camera_arc(span_deg))[:, [0, 2]])


def test_circle_fit_with_large_residual_is_rescan() -> None:
    a = np.radians(np.arange(0.0, 360.0, 10.0))
    r = np.where(np.arange(len(a)) % 2, 0.25, 0.65)  # zig-zag, not a circle
    xz = np.column_stack([r * np.cos(a), r * np.sin(a)])
    with pytest.raises(ReconstructionQualityError, match="did not circle the leg"):
        orbit_center(xz)


def test_partial_arc_without_anchor_is_rescan() -> None:
    with pytest.raises(ReconstructionQualityError, match="did not circle the leg"):
        segment_leg(make_leg_scene(), _positions(camera_arc(150.0)))


def test_anchor_is_the_axis_where_a_circle_fit_is_off() -> None:
    cams = _positions(camera_arc(150.0, taper_m=0.15))
    assert np.hypot(*(fit_circle(cams[:, [0, 2]]) - LEG_CENTER_XZ)) > 0.1

    seg = segment_leg(make_leg_scene(), cams, anchor_world=ANCHOR)

    assert seg.confidence["axis_source"] == AXIS_ANCHOR
    assert seg.confidence["ankle_width_m"] == pytest.approx(2 * ANKLE_R, abs=0.004)
    assert seg.confidence["calf_width_m"] == pytest.approx(2 * CALF_R, abs=0.004)
    assert seg.mesh.bounds[0, 1] == pytest.approx(ANKLE_Y, abs=0.01)
    assert seg.mesh.bounds[1, 1] == pytest.approx(KNEE_Y, abs=0.01)
    reference = segment_leg(make_leg_scene(), CAMERAS).confidence
    for key in ("ankle_width_m", "calf_width_m", "knee_width_m"):
        assert seg.confidence[key] == pytest.approx(reference[key], abs=1e-6)


def test_anchor_height_is_ignored() -> None:
    low, high = ANCHOR.copy(), ANCHOR.copy()
    low[1], high[1] = -3.0, 3.0
    a = segment_leg(make_leg_scene(), CAMERAS, anchor_world=low)
    b = segment_leg(make_leg_scene(), CAMERAS, anchor_world=high)
    assert a.confidence == b.confidence


def test_anchor_off_the_leg_is_rescan() -> None:
    far = ANCHOR + np.array([2.0, 0.0, 2.0])
    with pytest.raises(ReconstructionQualityError, match="No leg"):
        segment_leg(make_leg_scene(), CAMERAS, anchor_world=far)


@pytest.mark.parametrize("arc_deg", [180.0, 240.0])
def test_half_covered_leg_records_low_back_coverage(arc_deg: float) -> None:
    seg = segment_leg(
        make_leg_scene(arc_deg=arc_deg), _positions(camera_arc(150.0)), anchor_world=ANCHOR
    )
    assert seg.confidence["span_min_deg"] == pytest.approx(arc_deg, abs=1.0)
    assert seg.confidence["span_median_deg"] == pytest.approx(arc_deg, abs=1.0)
    assert seg.confidence["back_coverage_low"] is True
    assert seg.confidence["ankle_found"] and seg.confidence["knee_found"]


def test_back_coverage_threshold_is_on_the_median() -> None:
    assert BACK_COVERAGE_MIN_SPAN_DEG == 300.0
    seg = segment_leg(make_leg_scene(arc_deg=310.0), CAMERAS, anchor_world=ANCHOR)
    assert seg.confidence["span_median_deg"] == pytest.approx(310.0, abs=1.0)
    assert seg.confidence["back_coverage_low"] is False


def test_slice_spans_skip_empty_bins() -> None:
    a = np.radians([0.0, 90.0, 180.0])
    ring = np.column_stack([np.cos(a), np.zeros(3), np.sin(a)])
    verts = np.vstack([ring, ring + [0.0, 0.1, 0.0]])  # 20 empty bins between
    assert np.allclose(slice_spans_deg(verts, np.zeros(2)), [180.0, 180.0])
