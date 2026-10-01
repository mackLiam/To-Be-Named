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
    NO_KNEE_PROFILE,
    camera_ring,
    make_leg_scene,
)

from forms_pipeline.contract import SCHEMA
from forms_pipeline.extraction.measure import extract_measurements
from forms_pipeline.reconstruct import ReconstructionQualityError
from forms_pipeline.reconstruct.handler import export_obj_mm
from forms_pipeline.reconstruct.segment import (
    LEG_LENGTH_KEY,
    LEG_LENGTH_MAX_MM,
    LEG_LENGTH_MIN_MM,
    ORBIT_RADIUS_M,
    floor_height,
    meters_to_mm,
    orbit_center,
    segment_leg,
)

CAMERAS = np.array([m[:3, 3] for m in camera_ring().values()])


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
