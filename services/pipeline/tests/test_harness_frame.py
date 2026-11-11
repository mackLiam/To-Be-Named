"""Session frame -> ARKit-like world: convention, floor/up, leg position, scale, joints."""

from __future__ import annotations

import numpy as np
import pytest
from harness_synth import (
    CONVENTIONS,
    HEIGHT,
    INTRINSICS,
    WIDTH,
    encode_pose,
    floor_points,
    leg_points,
    random_similarity,
    scene,
    session_cameras,
)
from scipy.spatial.transform import Rotation

from forms_pipeline.harness import frame as fr
from forms_pipeline.reconstruct.silhouette import View, project


def _angle_deg(a: np.ndarray, b: np.ndarray) -> float:
    cos = a @ b / (np.linalg.norm(a) * np.linalg.norm(b))
    return float(np.degrees(np.arccos(np.clip(cos, -1.0, 1.0))))


@pytest.mark.parametrize("seed", [0, 1, 2])
@pytest.mark.parametrize("convention", CONVENTIONS)
def test_each_convention_is_resolved(convention: str, seed: int) -> None:
    sc, sim = scene(), random_similarity(seed)
    cams = session_cameras(sc, sim, convention, masks=True)
    choice = fr.resolve_convention(cams, sim.point(sc.points))
    assert choice.name == convention
    assert choice.in_view > 0.5 and choice.coverage > 0.9
    # A wrong reading can see much of a compact, far-off cloud (seeds 0 and 1 put a
    # wrong one near 0.5 in view), but squeezed into a spot it covers little mask.
    others = [s["coverage"] for n, s in choice.scores.items() if n != convention]
    assert max(others) < 0.3
    c2w = fr.to_camera_to_world(cams[0].transform, choice.name)
    assert np.allclose(c2w, sim.c2w(sc.c2w[0]), atol=1e-9)


def test_without_masks_the_in_view_score_decides() -> None:
    sc, sim = scene(), random_similarity(0)
    choice = fr.resolve_convention(session_cameras(sc, sim, "w2c_arkit"), sim.point(sc.points))
    assert choice.name == "w2c_arkit" and choice.coverage == 0.0
    assert choice.scores["c2w_arkit"]["in_view"] > 0.4  # near-tied, lower


def test_convention_tie_is_broken_by_the_person_masks() -> None:
    """One identity camera, equal point counts in front (-Z) and behind (+Z): both
    arkit and opencv readings see half the points; the masks decide."""
    rng = np.random.default_rng(0)
    front = np.column_stack([rng.uniform(-0.05, 0.05, (200, 2)), -np.ones(200)])
    back = np.column_stack([rng.uniform(0.15, 0.25, (200, 2)), np.ones(200)])
    pts = np.vstack([front, back])
    mask = np.zeros((HEIGHT, WIDTH), dtype=np.uint8)
    uv = project(np.eye(4), INTRINSICS, front)[0]
    lo, hi = np.floor(uv.min(0)).astype(int), np.ceil(uv.max(0)).astype(int)
    mask[lo[1] : hi[1] + 1, lo[0] : hi[0] + 1] = 255
    cam = fr.Camera(0, np.eye(4), INTRINSICS, WIDTH, HEIGHT, fr.MaskLookup.from_mask(mask))
    choice = fr.resolve_convention([cam], pts)
    assert choice.scores["c2w_arkit"]["in_view"] == pytest.approx(
        choice.scores["c2w_opencv"]["in_view"]
    )
    assert choice.name == "c2w_arkit" and choice.coverage > 0.8

    # Read as opencv, the back cluster is the one in front: a mask on it flips the choice.
    uv_back = project(np.diag([1.0, -1.0, -1.0, 1.0]), INTRINSICS, back)[0]
    lo, hi = np.floor(uv_back.min(0)).astype(int), np.ceil(uv_back.max(0)).astype(int)
    other = np.zeros_like(mask)
    other[lo[1] : hi[1] + 1, lo[0] : hi[0] + 1] = 255
    cam2 = fr.Camera(0, np.eye(4), INTRINSICS, WIDTH, HEIGHT, fr.MaskLookup.from_mask(other))
    assert fr.resolve_convention([cam2], pts).name == "c2w_opencv"


def test_cloud_behind_every_reading_is_a_frame_error() -> None:
    cam = fr.Camera(0, np.eye(4), INTRINSICS, WIDTH, HEIGHT)
    far_aside = np.array([[100.0, 0.0, 0.1], [0.0, 100.0, -0.1]])
    with pytest.raises(fr.FrameError, match="No pose convention"):
        fr.resolve_convention([cam], far_aside)


@pytest.mark.parametrize("seed", [0, 3, 4])
def test_floor_plane_gives_up_and_height(seed: int) -> None:
    sc, sim = scene(), random_similarity(seed)
    c2ws = [sim.c2w(m) for m in sc.c2w]
    centers = np.array([m[:3, 3] for m in c2ws])
    pts = sim.point(sc.points)
    floor = fr.fit_floor(pts, centers, fr.camera_mean_up(c2ws))
    assert floor is not None
    assert _angle_deg(floor.normal, sim.up) < 0.5
    assert 0.4 < floor.inlier_fraction < 0.6  # 3000 floor points of 6150

    member = fr.leg_membership(pts, c2ws, session_cameras(sc, sim, "c2w_arkit", masks=True))
    assert 0.4 < member.mean() < 0.6  # the 3000 leg-surface points of 6150
    assert fr.fit_floor(fr.floor_candidates(pts, member), centers, sim.up).inlier_fraction > 0.9
    leg, source = fr.leg_position(pts, member)
    assert source == fr.LEG_FROM_MASKS
    assert fr.leg_axis_angle_deg(pts, member, floor.normal) < 3.0
    world = fr.build_world(floor.normal, leg, centers, floor)
    true_floor = world.point(sim.point(floor_points(200, np.random.default_rng(1))))
    assert np.allclose(true_floor[:, 1], world.floor_y, atol=0.002)
    distances = np.linalg.norm(np.array([world.point(c) for c in centers]), axis=1)
    assert np.median(distances) == pytest.approx(fr.NOMINAL_CAMERA_DISTANCE_M)
    # The leg's vertical line passes near the world origin.
    true_axis = world.point(sim.point(np.array([[0.0, 0.0, 0.0], [0.0, 0.5, 0.0]])))
    assert np.abs(true_axis[:, [0, 2]]).max() < 0.03


def test_no_floor_plane_returns_none() -> None:
    sc, sim = scene(), random_similarity(0)
    rng = np.random.default_rng(2)
    pts = sim.point(leg_points(3000, rng))
    c2ws = [sim.c2w(m) for m in sc.c2w]
    centers = np.array([m[:3, 3] for m in c2ws])
    assert fr.fit_floor(pts, centers, fr.camera_mean_up(c2ws)) is None


def test_a_bigger_wall_does_not_beat_the_floor() -> None:
    sc = scene()
    rng = np.random.default_rng(3)
    wall = np.column_stack(
        [rng.uniform(-1.5, 1.5, 6000), rng.uniform(0.0, 2.0, 6000), np.full(6000, -1.0)]
    )
    pts = np.vstack([leg_points(2000, rng), floor_points(2000, rng), wall])
    centers = np.array([m[:3, 3] for m in sc.c2w])
    floor = fr.fit_floor(pts, centers, fr.camera_mean_up(list(sc.c2w)))
    assert floor is not None and _angle_deg(floor.normal, np.array([0.0, 1.0, 0.0])) < 0.5


def test_a_flat_leg_face_is_not_taken_for_the_floor() -> None:
    """Close-up clouds are mostly leg (real bundles: about 90%). A flat slab of shin
    facing the cameras, tilted toward camera-up, passes the plane gates on its own;
    leaving the leg points out of the fit leaves no floor and the fallback applies."""
    sc = scene()
    rng = np.random.default_rng(4)
    slab = np.column_stack(
        [rng.uniform(-0.04, 0.04, 3000), rng.uniform(0.0, 0.5, 3000), np.full(3000, 0.05)]
    )
    tilt = Rotation.from_euler("x", -45.0, degrees=True).as_matrix()
    slab = (slab - [0.0, 0.25, 0.0]) @ tilt.T + [0.0, 0.25, 0.0]
    pts = np.vstack([slab, rng.uniform(-1.0, 1.0, (200, 3))])
    centers = np.array([m[:3, 3] for m in sc.c2w])
    up = np.array([0.0, 1.0, 0.0])
    assert fr.fit_floor(pts, centers, up) is not None  # the slab alone looks like a floor
    member = np.zeros(len(pts), dtype=bool)
    member[:3000] = True
    assert fr.fit_floor(fr.floor_candidates(pts, member), centers, up) is None


def test_camera_mean_up_is_the_fallback_direction() -> None:
    sc, sim = scene(), random_similarity(1)
    up = fr.camera_mean_up([sim.c2w(m) for m in sc.c2w])
    # Cameras pitch about 7 degrees down at the leg; on a 150 degree arc the mean of
    # their image-up vectors leans about 5 degrees toward the arc's middle.
    assert _angle_deg(up, sim.up) < 6.0
    with pytest.raises(fr.FrameError, match="disagree"):
        fr.camera_mean_up([np.eye(4), np.diag([1.0, -1.0, -1.0, 1.0])])


def test_leg_position_falls_back_to_the_cloud_median() -> None:
    pts = np.random.default_rng(0).normal(size=(500, 3))
    cams = [fr.Camera(0, np.eye(4), INTRINSICS, WIDTH, HEIGHT)]
    member = fr.leg_membership(pts, [np.eye(4)], cams)
    assert member is None
    point, source = fr.leg_position(pts, member)
    assert source == fr.LEG_FROM_CLOUD
    assert np.allclose(point, np.median(pts, axis=0))
    assert fr.floor_candidates(pts, None) is pts
    assert fr.leg_axis_angle_deg(pts, None, np.array([0, 1.0, 0])) is None
    few = np.zeros(len(pts), dtype=bool)
    few[:5] = True
    assert fr.leg_position(pts, few)[1] == fr.LEG_FROM_CLOUD


def test_up_rotation_is_proper_and_maps_up_to_y() -> None:
    rng = np.random.default_rng(5)
    for up in [*rng.normal(size=(20, 3)), np.array([1.0, 0, 0]), np.array([0, -1.0, 0])]:
        r = fr.up_rotation(up)
        assert np.allclose(r @ r.T, np.eye(3)) and np.linalg.det(r) == pytest.approx(1.0)
        assert np.allclose(r @ (up / np.linalg.norm(up)), [0.0, 1.0, 0.0])


def test_world_camera_keeps_projection() -> None:
    """A world point projects to the same pixel before and after the session -> world map."""
    sc, sim = scene(), random_similarity(6)
    c2w = sim.c2w(sc.c2w[5])
    world = fr.WorldFrame(Rotation.random(random_state=1).as_matrix(), np.ones(3), 0.37, None)
    p = sim.point(np.array([[0.01, 0.2, 0.02], [0.0, 0.4, -0.03]]))
    uv0 = project(c2w, INTRINSICS, p)[0]
    uv1 = project(world.camera_to_world(c2w), INTRINSICS, world.point(p))[0]
    assert np.allclose(uv0, uv1, atol=1e-6)


def test_encode_and_decode_are_inverse_for_every_convention() -> None:
    c2w = random_similarity(9).c2w(scene().c2w[2])
    for name in CONVENTIONS:
        assert np.allclose(fr.to_camera_to_world(encode_pose(c2w, name), name), c2w)
    with pytest.raises(ValueError, match="unknown convention"):
        fr.to_camera_to_world(np.eye(4), "c2w_blender")


def test_intrinsics_assumed_when_missing_or_off_frame() -> None:
    assert fr.frame_intrinsics(None, 720, 1280) == (
        (0.69 * 1280, 0.69 * 1280, 359.5, 639.5),
        fr.INTRINSICS_ASSUMED,
    )
    given = (880.0, 880.0, 360.0, 640.0)
    assert fr.frame_intrinsics(given, 720, 1280) == (given, fr.INTRINSICS_POSE)
    landscape = (880.0, 880.0, 640.0, 360.0)
    assert fr.frame_intrinsics(landscape, 720, 1280)[1] == fr.INTRINSICS_ASSUMED


def test_build_world_rejects_cameras_on_the_leg() -> None:
    with pytest.raises(fr.FrameError, match="no scale"):
        fr.build_world(np.array([0, 1.0, 0]), np.zeros(3), np.zeros((3, 3)), None)


def test_mask_coverage() -> None:
    mask = np.zeros((320, 240), dtype=np.uint8)
    mask[0:160, 0:240] = 255  # top half
    lookup = fr.MaskLookup.from_mask(mask)
    u, v = np.meshgrid(np.arange(0, 240, 2.0), np.arange(0, 320, 2.0))
    everywhere = np.column_stack([u.ravel(), v.ravel()])
    assert lookup.coverage(everywhere) == pytest.approx(1.0)
    assert lookup.coverage(everywhere[everywhere[:, 1] > 170]) == 0.0
    assert lookup.coverage(np.array([[5.0, 5.0]])) == pytest.approx(1 / (16 * 24))
    assert fr.MaskLookup.from_mask(np.zeros((8, 8), np.uint8)).coverage(everywhere) == 0.0


def test_mask_lookup() -> None:
    mask = np.zeros((1280, 720), dtype=np.uint8)
    mask[100:200, 300:400] = 255
    lookup = fr.MaskLookup.from_mask(mask)
    assert lookup.stride == 4
    uv = np.array([[350.0, 150.0], [10.0, 10.0], [-5.0, 150.0], [np.nan, 1.0], [350.0, 5000.0]])
    assert lookup.contains(uv).tolist() == [True, False, False, False, False]


def test_joint_side_and_view_joints() -> None:
    sc = scene()
    lookups = [fr.MaskLookup.from_mask(m) for m in sc.masks]
    assert fr.joint_side(sc.joints, lookups) == "right"
    assert fr.joint_side([{}] * 3, [None] * 3) is None
    mapped = fr.view_joints(sc.joints[0], "right")
    assert list(mapped["knee"]) == sc.joints[0]["right_knee"]
    assert list(mapped["ankle"]) == sc.joints[0]["right_ankle"]
    assert fr.view_joints(sc.joints[0], None) is None


def test_rescale_views_scales_about_the_origin() -> None:
    c2w = np.eye(4)
    c2w[:3, 3] = [0.1, 0.2, 0.3]
    view = View("kf00", np.zeros((4, 4), dtype=np.uint8), c2w, INTRINSICS)
    (out,), floor = fr.rescale_views([view], -0.3, 2.5)
    assert np.allclose(out.camera_to_world[:3, 3], [0.25, 0.5, 0.75])
    assert np.allclose(out.camera_to_world[:3, :3], np.eye(3))
    assert floor == pytest.approx(-0.75)
    assert fr.rescale_views([view], None, 2.0)[1] is None
