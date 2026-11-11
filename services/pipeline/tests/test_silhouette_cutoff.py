"""Close-up framing: the leg runs out of the photo at a side or an end.

The synthetic station photos of test_silhouette are cropped (smaller image, principal
point moved, so the camera model stays exact): where the leg crosses the new border
the mask edge is the frame, not the leg. A cut-off edge gives no tangent line at that
height while the other edge and the other views still count (SCAN-V3-PLAN.md 4.5).
What remains must measure as before; when too little remains the retake reason names
what was missing. The phone is held upright: the leg runs along u with the knee toward
u = 0, and its two sides are the top and bottom rows of the leg.
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest
from test_silhouette import (
    ANKLE_H,
    FLOOR_Y,
    KNEE_H,
    NOISY_MEDIAN_TOLERANCE,
    NOISY_TOLERANCE,
    clean_result,
    leg_base,
    measured,
    noisy_views,
    relative_errors,
    views,
)

from forms_pipeline.reconstruct import ReconstructionQualityError
from forms_pipeline.reconstruct.silhouette import (
    SILHOUETTE_VERSION,
    View,
    project,
    reconstruct_silhouette,
)

CLEAN_TOLERANCE = 0.02  # test_silhouette's clean-capture bound


def crop(
    view: View, r0: int = 0, r1: int | None = None, c0: int = 0, c1: int | None = None
) -> View:
    """The photo a camera with a smaller sensor window would have taken."""
    h, w = view.mask.shape
    fx, fy, cx, cy = view.intrinsics
    mask = np.ascontiguousarray(
        view.mask[r0 : h if r1 is None else r1, c0 : w if c1 is None else c1]
    )
    return replace(view, mask=mask, intrinsics=(fx, fy, cx - c0, cy - r0))


def u_at(view: View, height: float) -> int:
    """Image column of the leg axis at a height above the floor."""
    point = leg_base() + np.array([0.0, height, 0.0])
    return int(project(view.camera_to_world, view.intrinsics, point[None])[0][0, 0])


def thigh_off_the_end(view: View) -> View:
    """The frame ends 60 mm above the knee: the thigh runs off, the knee dip stays."""
    return crop(view, c0=u_at(view, KNEE_H + 0.06))


def side_off(view: View) -> View:
    """The top side of the shin is outside the frame from the ankle to the knee."""
    cols = np.arange(u_at(view, KNEE_H), u_at(view, ANKLE_H) + 1)
    leg = view.mask[:, cols] >= 128
    top_edge = leg.argmax(axis=0)
    return crop(view, r0=int(top_edge.max()) + 3)


def _errors(vs: list[View]) -> tuple[dict[str, float], dict]:
    result = reconstruct_silhouette(vs, floor_y=FLOOR_Y)
    assert result.mesh.is_watertight and result.mesh.volume > 0
    return relative_errors(measured(result.mesh)), result.artifacts


def test_crop_keeps_the_camera_model() -> None:
    view = views(0.0)[0]
    cropped = crop(view, r0=40, r1=1300, c0=100)
    point = leg_base() + np.array([0.0, 0.3, 0.0])
    uv = project(view.camera_to_world, view.intrinsics, point[None])[0][0]
    uv_c = project(cropped.camera_to_world, cropped.intrinsics, point[None])[0][0]
    assert uv_c == pytest.approx(uv - [100, 40])
    assert cropped.mask[int(uv_c[1]), int(uv_c[0])] == view.mask[int(uv[1]), int(uv[0])]


def test_side_off_puts_one_shin_edge_on_the_border() -> None:
    view = side_off(views(0.0)[2])
    cols = np.arange(u_at(view, KNEE_H), u_at(view, ANKLE_H) + 1)
    leg = view.mask[:, cols] >= 128
    assert leg[0].all()  # the top side runs into the frame at every shin height
    assert not leg[-1].any()  # the bottom side is inside the frame


def test_thigh_running_off_the_end_still_measures() -> None:
    errors, art = _errors([thigh_off_the_end(v) for v in views(0.0)])
    assert max(errors.values()) < CLEAN_TOLERANCE, errors
    assert art["views_cut_off_above"] == 5 and art["views_cut_off_below"] == 0


def test_a_side_off_the_frame_in_two_views_still_measures() -> None:
    vs = [side_off(v) if i in (1, 3) else v for i, v in enumerate(views(0.0))]
    errors, art = _errors(vs)
    assert max(errors.values()) < CLEAN_TOLERANCE, errors
    # Those two views give one edge each, not their centerline.
    assert art["views_used"] == 5 and art["views_axis"] == 3
    assert art["edges_at_border_fraction"] > 0.15


def test_a_side_off_in_three_of_five_views_leaves_too_few_centerlines() -> None:
    """The axis needs MIN_VIEWS traced centerlines; one-edge views cannot supply it."""
    vs = [side_off(v) if i in (0, 2, 4) else v for i, v in enumerate(views(0.0))]
    with pytest.raises(ReconstructionQualityError, match="hold the phone further back"):
        reconstruct_silhouette(vs, floor_y=FLOOR_Y)


def test_a_close_up_still_measures() -> None:
    vs = [thigh_off_the_end(v) for v in views(0.0)]
    vs = [side_off(v) if i in (1, 3) else v for i, v in enumerate(vs)]
    errors, _ = _errors(vs)
    assert max(errors.values()) < CLEAN_TOLERANCE, errors


def test_a_noisy_close_up_measures_within_the_noisy_tolerance() -> None:
    vs = [thigh_off_the_end(v) for v in noisy_views(0.0, 11)]
    vs = [side_off(v) if i in (1, 3) else v for i, v in enumerate(vs)]
    errors, _ = _errors(vs)
    assert max(errors.values()) < NOISY_TOLERANCE, errors
    assert float(np.median(list(errors.values()))) < NOISY_MEDIAN_TOLERANCE, errors


def test_lower_half_filled_to_the_border_in_one_view_still_measures() -> None:
    """The case that used to fail the whole capture: in one view the leg's lower side
    is smeared to the bottom border along its length. That edge is dropped; the
    view's other edge and the other four views still count."""
    vs = views(0.0)
    mask = vs[2].mask.copy()
    cols = np.flatnonzero(mask.any(axis=0))
    rows = np.flatnonzero(mask.any(axis=1))
    mid = (rows[0] + rows[-1]) // 2
    mask[mid:, cols[0] : cols[-1] + 1] = np.maximum(
        mask[mid:, cols[0] : cols[-1] + 1], mask[mid : mid + 1, cols[0] : cols[-1] + 1]
    )
    vs[2] = replace(vs[2], mask=mask)
    errors, art = _errors(vs)
    assert max(errors.values()) < CLEAN_TOLERANCE, errors
    assert art["views_used"] == 5 and art["edges_at_border_fraction"] > 0.05


def test_knee_outside_the_frame_names_the_knee() -> None:
    vs = [crop(v, c0=u_at(v, KNEE_H - 0.02)) for v in views(0.0)]
    with pytest.raises(ReconstructionQualityError, match="knee was outside the frame") as exc:
        reconstruct_silhouette(vs, floor_y=FLOOR_Y)
    assert "above the knee" in str(exc.value) and "retake the photos" in str(exc.value)


def test_foot_outside_the_frame_names_the_ankle() -> None:
    vs = [crop(v, c1=u_at(v, ANKLE_H - 0.01)) for v in views(0.0)]
    with pytest.raises(ReconstructionQualityError, match="ankle was outside the frame"):
        reconstruct_silhouette(vs, floor_y=FLOOR_Y)


def test_too_close_in_every_view_says_to_step_back() -> None:
    vs = [side_off(v) for v in views(0.0)]
    with pytest.raises(ReconstructionQualityError, match="hold the phone further back"):
        reconstruct_silhouette(vs, floor_y=FLOOR_Y)


def test_reasons_are_leg_relative_and_plain() -> None:
    """SCAN-V3-PLAN.md 5.3: no left or right; repo rule: no em or en dashes."""
    from forms_pipeline.reconstruct import silhouette

    for name in ("_TOO_CLOSE", "_ANKLE_OUT", "_KNEE_OUT", "_NOT_TRACED"):
        text = getattr(silhouette, name).lower()
        assert "left" not in text and "right" not in text, name
        assert "\u2014" not in text and "\u2013" not in text, name


def test_artifacts_carry_the_version_and_framing() -> None:
    art = clean_result(0.0).artifacts
    assert art["silhouette_version"] == SILHOUETTE_VERSION
    assert art["edges_at_border_fraction"] == 0.0
    assert art["views_cut_off_above"] == art["views_cut_off_below"] == 0
    assert art["views_axis"] == 5
