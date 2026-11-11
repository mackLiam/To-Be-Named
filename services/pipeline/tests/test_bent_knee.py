"""A bent knee must not shorten Leg_Length (tests/bent_knee_synth.py, 2026-11-11).

With the knee flexed, slices perpendicular to the shin cut the thigh before they reach
the dip below the kneecap. Measured on the hinged truth leg before the thigh onset rule
(silhouette v3), the knee landed on the foot of the thigh's rise: Leg_Length -1.0% at 45
degrees, -2.9% at 60, -5.9% at 75, -14.6% at 90; the photogrammetry profile of the same
solid -2.6% at 60 and -11.8% at 90. The dip is hidden, so a leg bent that far is a
retake that asks for a straighter leg; up to 45 degrees it measures as before.
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest
from bent_knee_synth import JOINT_H, bent_views, inside_bent
from scipy.spatial import ConvexHull
from test_silhouette import (
    ANKLE_H,
    ELLIPSE_ANGLE_RAD,
    FLOOR_Y,
    KNEE_H,
    TOP_H,
    leg_base,
    measured,
    relative_errors,
    section,
)

from forms_pipeline.reconstruct import ReconstructionQualityError, segment, silhouette
from forms_pipeline.reconstruct.segment import (
    BIN_M,
    MAX_LIMB_SLOPE,
    ORBIT_RADIUS_M,
    profile_landmarks,
    thigh_onset,
)
from forms_pipeline.reconstruct.silhouette import project, reconstruct_silhouette

CLEAN_TOLERANCE = 0.02  # test_silhouette's clean-capture bound
TRUE_LENGTH_M = KNEE_H - ANKLE_H

# Smoothed-profile shape of the straight truth leg (mm per 5 mm bin from the floor):
# foot at bin 0, ankle minimum at 15, calf at 54, the dip below the kneecap at 91, then the thigh.
_BINS = np.arange(120)
_STRAIGHT_MM = np.interp(_BINS, [0, 15, 54, 91, 112, 119], [130.0, 68.0, 106.0, 89.5, 119.0, 122.0])


def _with_thigh_from(start: int, rise_mm_per_bin: float) -> np.ndarray:
    """The straight profile with a thigh rising from bin start at the given rate."""
    out = _STRAIGHT_MM.copy()
    above = _BINS > start
    out[above] = out[start] + rise_mm_per_bin * (_BINS[above] - start)
    return out / 1000.0


# --- the rule (pure) --------------------------------------------------------------------


def test_a_straight_leg_has_no_thigh_onset() -> None:
    widths, (_, calf, knee) = profile_landmarks(_STRAIGHT_MM / 1000.0)
    assert thigh_onset(widths, calf) is None
    assert abs(knee - 91) <= 1


def test_the_foot_of_a_thigh_rise_is_not_the_knee() -> None:
    """The 90 degree case: the thigh comes in at bin 79 while the shin still tapers."""
    widths, (ankle, calf, knee) = profile_landmarks(_with_thigh_from(79, 9.0))
    assert ankle is not None and calf is not None
    assert knee is None
    assert abs(thigh_onset(widths, calf) - 79) <= 2


def test_a_dip_clear_of_the_thigh_is_still_the_knee() -> None:
    """The dip itself in view, the thigh coming in 40 mm above it: the dip is kept."""
    _, (_, _, knee) = profile_landmarks(_with_thigh_from(99, 9.0))
    assert knee is not None and abs(knee - 91) <= 1


def test_a_rise_as_steep_as_a_straight_knee_is_not_a_thigh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A rise at half the bound, about the straight truth leg's steepest above its dip,
    leaves the knee where the rule without an onset put it."""
    profile = _with_thigh_from(91, 0.5 * MAX_LIMB_SLOPE * BIN_M * 1000.0)
    widths, (_, calf, knee) = profile_landmarks(profile)
    assert thigh_onset(widths, calf) is None
    monkeypatch.setattr(segment, "MAX_LIMB_SLOPE", np.inf)
    assert knee is not None and knee == profile_landmarks(profile)[1][2]


def test_the_bent_knee_reason_is_plain_and_names_the_bend() -> None:
    text = silhouette._KNEE_BENT.lower()
    assert "left" not in text and "right" not in text
    assert chr(0x2014) not in text and chr(0x2013) not in text  # em and en dash
    assert "foot further forward" in text
    widths = _with_thigh_from(79, 9.0)
    assert silhouette._landmark_reason(widths, False, False, True, True) == silhouette._KNEE_BENT
    assert silhouette._landmark_reason(widths, False, False, True) == silhouette._KNEE_OUT


# --- the scene ------------------------------------------------------------------------------


def test_the_bent_scene_keeps_the_truth_shin() -> None:
    """Below the thigh the solid is test_silhouette's truth leg at any flexion, and at
    flexion 0 it is that leg all the way to TOP_H."""
    rng = np.random.default_rng(1)
    p = rng.uniform([-0.12, 0.0, -0.12], [0.12, TOP_H, 0.2], (200_000, 3))
    a, b, cx, cz = section(p[:, 1])
    c, s = np.cos(ELLIPSE_ANGLE_RAD), np.sin(ELLIPSE_ANGLE_RAD)
    dx, dz = p[:, 0] - cx, p[:, 2] - cz
    truth = ((c * dx + s * dz) / a) ** 2 + ((-s * dx + c * dz) / b) ** 2 <= 1.0
    # The table lookup puts a section at most 0.1 mm off in height.
    near_edge = np.abs(((c * dx + s * dz) / a) ** 2 + ((-s * dx + c * dz) / b) ** 2 - 1) < 0.01
    assert np.array_equal(inside_bent(p, 0.0)[~near_edge], truth[~near_edge])
    low = p[:, 1] < JOINT_H - 0.07
    assert np.array_equal(inside_bent(p, 90.0)[low & ~near_edge], truth[low & ~near_edge])


# --- silhouette, end to end -----------------------------------------------------------------


@pytest.mark.parametrize("flexion_deg", [0.0, 30.0])
def test_a_slightly_bent_knee_measures_like_a_straight_one(flexion_deg: float) -> None:
    result = reconstruct_silhouette(list(bent_views(flexion_deg)), floor_y=FLOOR_Y)
    errors = relative_errors(measured(result.mesh))
    assert max(errors.values()) < CLEAN_TOLERANCE, errors
    assert result.artifacts["leg_length_m"] == pytest.approx(TRUE_LENGTH_M, rel=CLEAN_TOLERANCE)


@pytest.mark.parametrize("flexion_deg", [60.0, 90.0])
def test_a_bent_knee_is_a_retake_not_a_short_leg(flexion_deg: float) -> None:
    with pytest.raises(ReconstructionQualityError, match="bent too far") as exc:
        reconstruct_silhouette(list(bent_views(flexion_deg)), floor_y=FLOOR_Y)
    assert "foot further forward" in str(exc.value)


def test_a_knee_joint_near_the_thigh_rise_cannot_seed_the_cut() -> None:
    """A body-pose knee 30 mm low puts the foot of the thigh's rise inside the seed
    window, where it is the narrowest bin; the seeded cut obeys the thigh onset too."""
    vs = []
    for v in bent_views(90.0):
        joints = {}
        for name, h in (("ankle", ANKLE_H), ("knee", KNEE_H - 0.03)):
            _, _, cx, cz = section(np.array([h]))
            point = leg_base() + np.array([cx[0], h, cz[0]])
            u, y = project(v.camera_to_world, v.intrinsics, point[None])[0][0]
            joints[name] = (float(u), float(y), 0.9)
        vs.append(replace(v, joints=joints))
    with pytest.raises(ReconstructionQualityError, match="bent too far"):
        reconstruct_silhouette(vs, floor_y=FLOOR_Y)


# --- the photogrammetry profile (segment.width_profile's convex-hull sections) ---------------


def _hull_profile(flexion_deg: float) -> tuple[np.ndarray, np.ndarray]:
    """Equivalent diameter of each horizontal section of the bent solid within the orbit
    crop, as segment_leg measures a mesh (upright shin, so its slices are horizontal)."""
    g = np.arange(-ORBIT_RADIUS_M, ORBIT_RADIUS_M + 0.002, 0.002)
    gx, gz = np.meshgrid(g, g)
    disc = np.hypot(gx, gz) <= ORBIT_RADIUS_M
    xz = np.column_stack([gx[disc], gz[disc]])
    heights = np.arange(BIN_M / 2, 0.8, BIN_M)
    raw = np.full(len(heights), np.nan)
    for i, h in enumerate(heights):
        p = np.column_stack([xz[:, 0], np.full(len(xz), h), xz[:, 1]])
        inside = xz[inside_bent(p, flexion_deg)]
        if len(inside) >= 3:
            raw[i] = np.sqrt(4.0 * ConvexHull(inside).volume / np.pi)
    return heights, raw


def _hull_leg_length(flexion_deg: float) -> float | None:
    heights, raw = _hull_profile(flexion_deg)
    _, (ankle, _, knee) = profile_landmarks(raw)
    return None if ankle is None or knee is None else float(heights[knee] - heights[ankle])


def test_the_photogrammetry_profile_has_the_same_defect_and_fix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    straight = _hull_leg_length(0.0)
    assert straight == pytest.approx(TRUE_LENGTH_M, rel=CLEAN_TOLERANCE)
    assert _hull_leg_length(90.0) is None
    monkeypatch.setattr(segment, "MAX_LIMB_SLOPE", np.inf)  # the rule before the onset
    bent = _hull_leg_length(90.0)
    assert bent is not None and bent < 0.9 * TRUE_LENGTH_M
