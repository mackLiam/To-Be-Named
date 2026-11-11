"""Typed Leg_Length: a user-attested ankle-to-knee length replaces the knee landmark.

With the knee bent near 90 degrees the thigh hides the dip below the kneecap, so the
landmark rule makes the capture a retake (tests/test_bent_knee.py). With the length
typed in, only the ankle comes from the profile, and the S1 to S4 slices at 20 to 80%
of the length sit below where the thigh enters: on the hinged truth leg the thigh onset
is at 105% of the true length at 45 degrees, 100% at 60, 96% at 75 and 87% at 90
(docs/SCAN-V3-PLAN.md 5.1 estimated 84% at 90 from a hand-drawn profile).
"""

from __future__ import annotations

import math
from dataclasses import replace

import numpy as np
import pytest
from bent_knee_synth import INTRINSICS, bent_views
from test_silhouette import (
    ANKLE_H,
    FLOOR_Y,
    KNEE_H,
    clean_result,
    leg_base,
    measured,
    relative_errors,
)

from forms_pipeline.extraction.measure import SLICE_FRACTIONS
from forms_pipeline.reconstruct import ReconstructionQualityError, silhouette
from forms_pipeline.reconstruct.segment import BIN_M, profile_landmarks
from forms_pipeline.reconstruct.silhouette import (
    TOP_SLICE_FRACTION,
    TYPED_COVER_MARGIN_M,
    TYPED_LENGTH_OUT_OF_RANGE,
    View,
    check_typed_length,
    project,
    reconstruct_silhouette,
    typed_cut,
)

CLEAN_TOLERANCE = 0.02  # test_silhouette's clean-capture bound
TRUE_LENGTH_M = KNEE_H - ANKLE_H
SLICE_KEYS = [f"{s}_{d}" for s in SLICE_FRACTIONS for d in ("OW", "OD")]

# Smoothed-profile shape of the straight truth leg (mm per 5 mm bin from the floor), as
# in test_bent_knee: foot at bin 0, ankle minimum at 15, calf at 54, the dip below the
# kneecap at 91, then the thigh.
_BINS = np.arange(120)
_STRAIGHT_MM = np.interp(_BINS, [0, 15, 54, 91, 112, 119], [130.0, 68.0, 106.0, 89.5, 119.0, 122.0])


def _with_thigh_from(start: int, rise_mm_per_bin: float) -> np.ndarray:
    out = _STRAIGHT_MM.copy()
    above = _BINS > start
    out[above] = out[start] + rise_mm_per_bin * (_BINS[above] - start)
    return out / 1000.0


def _typed(views: list[View], length_m: float) -> silhouette.SilhouetteResult:
    return reconstruct_silhouette(views, floor_y=FLOOR_Y, leg_length_m=length_m)


# --- the rule (pure) ------------------------------------------------------------------------


def test_the_typed_range_is_the_schema_leg_length_range() -> None:
    check_typed_length(0.150)
    check_typed_length(0.600)
    for bad in (0.1499, 0.6001, 0.0, -TRUE_LENGTH_M, math.nan, math.inf):
        with pytest.raises(ReconstructionQualityError) as exc:
            check_typed_length(bad)
        assert str(exc.value) == TYPED_LENGTH_OUT_OF_RANGE


def test_the_out_of_range_reason_is_plain() -> None:
    text = TYPED_LENGTH_OUT_OF_RANGE.lower()
    assert "left" not in text and "right" not in text
    assert chr(0x2014) not in text and chr(0x2013) not in text  # em and en dash
    assert "bottom of the ankle to the knee" in text


def _grid() -> np.ndarray:
    return np.arange(len(_BINS)) * BIN_M + BIN_M / 2


def test_a_straight_profile_cuts_at_the_typed_length() -> None:
    widths, (ankle, calf, _) = profile_landmarks(_STRAIGHT_MM / 1000.0)
    grid = _grid()
    cut = typed_cut(widths, grid, ankle, calf, float(grid[-1]), TRUE_LENGTH_M)
    assert cut.s_ankle == grid[ankle]
    assert cut.s_knee == pytest.approx(grid[ankle] + TRUE_LENGTH_M, abs=1e-12)
    assert cut.onset_fraction is None
    assert cut.s_hold == grid[-1]


def test_a_thigh_above_the_top_slice_is_held_off_the_loft() -> None:
    """The 90 degree shape: the thigh rises from bin 79, 64 bins above the ankle; a
    380 mm length (76 bins) puts the top slice at 61 bins, below the onset."""
    widths, (ankle, calf, knee) = profile_landmarks(_with_thigh_from(79, 9.0))
    assert knee is None  # the landmark rule finds no knee here
    grid = _grid()
    cut = typed_cut(widths, grid, ankle, calf, float(grid[-1]), TRUE_LENGTH_M)
    assert TOP_SLICE_FRACTION < cut.onset_fraction < 1.0
    assert cut.s_hold == pytest.approx(cut.s_ankle + cut.onset_fraction * TRUE_LENGTH_M)
    assert cut.s_hold < cut.s_knee


def test_a_thigh_below_the_top_slice_is_a_bent_knee_retake() -> None:
    widths, (ankle, calf, _) = profile_landmarks(_with_thigh_from(79, 9.0))
    grid = _grid()
    with pytest.raises(ReconstructionQualityError, match="bent too far"):
        typed_cut(widths, grid, ankle, calf, float(grid[-1]), 0.45)


def test_a_profile_ending_below_the_top_slice_is_a_knee_out_retake() -> None:
    widths, (ankle, calf, _) = profile_landmarks(_STRAIGHT_MM / 1000.0)
    grid = _grid()
    top_slice = grid[ankle] + TOP_SLICE_FRACTION * TRUE_LENGTH_M
    typed_cut(widths, grid, ankle, calf, top_slice + TYPED_COVER_MARGIN_M, TRUE_LENGTH_M)
    with pytest.raises(ReconstructionQualityError, match="knee was outside the frame"):
        typed_cut(widths, grid, ankle, calf, top_slice + 0.5 * TYPED_COVER_MARGIN_M, TRUE_LENGTH_M)


# --- silhouette, end to end -----------------------------------------------------------------

# Measured with the true length typed in (relative error, %, S1..S4 OW/OD, worst):
# 0 degrees 0.37, 45: 0.42, 60: 0.70, 90: 0.35. Onset fractions in the module docstring.
_ONSET = {0.0: None, 45.0: 1.053, 60.0: 1.0, 90.0: 0.868}


@pytest.mark.parametrize("flexion_deg", [0.0, 45.0, 60.0, 90.0])
def test_a_typed_length_measures_a_bent_knee_like_a_straight_leg(flexion_deg: float) -> None:
    result = _typed(list(bent_views(flexion_deg)), TRUE_LENGTH_M)
    errors = relative_errors(measured(result.mesh))
    slices = {k: errors[k] for k in SLICE_KEYS}
    assert max(slices.values()) < CLEAN_TOLERANCE, slices
    # The typed value is the Leg_Length; the mesh only has to carry it within tolerance.
    assert errors["Leg_Length"] < CLEAN_TOLERANCE, errors
    art = result.artifacts
    assert art["leg_length_m"] == TRUE_LENGTH_M
    assert art["leg_length_source"] == "typed"
    expected = _ONSET[flexion_deg]
    if expected is None:
        assert art["thigh_onset_fraction"] is None
    else:
        assert art["thigh_onset_fraction"] == pytest.approx(expected, abs=0.03)
        assert art["thigh_onset_fraction"] > TOP_SLICE_FRACTION
    assert result.mesh.is_watertight and result.mesh.volume > 0


def test_the_typed_length_is_reported_exactly_and_sets_the_mesh_length() -> None:
    typed = 0.3712
    result = _typed(list(bent_views(0.0)), typed)
    assert result.artifacts["leg_length_m"] == typed
    axis = np.array(result.artifacts["axis_direction"])
    along = result.mesh.vertices @ axis
    assert along.max() - along.min() == pytest.approx(typed, abs=1e-9)


def test_an_out_of_range_typed_length_fails_before_any_reconstruction() -> None:
    with pytest.raises(ReconstructionQualityError) as exc:
        reconstruct_silhouette([], floor_y=FLOOR_Y, leg_length_m=0.7)
    assert str(exc.value) == TYPED_LENGTH_OUT_OF_RANGE


def test_a_typed_length_beyond_the_visible_leg_is_a_retake() -> None:
    """Everything above 100 mm below the knee out of frame: the profile ends below the
    top slice of the true length."""
    vs = []
    for v in bent_views(0.0):
        cut = leg_base() + np.array([0.0, KNEE_H - 0.10, 0.0])
        u_cut = project(v.camera_to_world, INTRINSICS, cut[None])[0][0, 0]
        mask = v.mask.copy()
        mask[:, : int(u_cut)] = 0  # image right is down
        vs.append(replace(v, mask=mask))
    with pytest.raises(ReconstructionQualityError, match="knee was outside the frame"):
        _typed(vs, TRUE_LENGTH_M)


def test_a_typed_length_past_the_thigh_onset_is_a_bent_knee_retake() -> None:
    """At 90 degrees the thigh enters 330 mm above the ankle; 450 mm typed puts the top
    slice at 360 mm, inside the thigh."""
    with pytest.raises(ReconstructionQualityError, match="bent too far") as exc:
        _typed(list(bent_views(90.0)), 0.45)
    assert "foot further forward" in str(exc.value)


def test_without_a_typed_length_the_landmark_rule_is_unchanged() -> None:
    """The straight truth leg's default result: test_silhouette's expectations hold, and
    the new artifacts say the landmark rule set the length. Byte identity with the
    pre-typed code was checked once by hand (2026-11-11), not pinned here."""
    result = clean_result(0.0)
    art = result.artifacts
    assert art["leg_length_source"] == "landmark"
    assert art["thigh_onset_fraction"] is None
    assert art["silhouette_version"] == "4"
    assert max(relative_errors(measured(result.mesh)).values()) < CLEAN_TOLERANCE
    assert art["leg_length_m"] == pytest.approx(TRUE_LENGTH_M, rel=CLEAN_TOLERANCE)
