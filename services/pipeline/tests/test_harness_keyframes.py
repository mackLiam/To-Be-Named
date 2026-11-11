"""Azimuth keyframe choice (docs/SCAN-V3-PLAN.md section 5.2): sharpness, spacing, cap, span."""

from __future__ import annotations

import numpy as np
import pytest

from forms_pipeline.harness.keyframes import (
    MIN_SEPARATION_DEG,
    Candidate,
    azimuths_deg,
    choose_keyframes,
    span_deg,
)


def _gaps(azimuths: tuple[float, ...]) -> np.ndarray:
    az = np.array(azimuths)
    d = np.abs((az[:, None] - az[None, :] + 180.0) % 360.0 - 180.0)
    return d[~np.eye(len(az), dtype=bool)]


def _sweep(n: int, arc: float, seed: int = 0) -> list[Candidate]:
    rng = np.random.default_rng(seed)
    az = np.linspace(-arc / 2, arc / 2, n)
    return [Candidate(i, float(a), float(rng.uniform(80, 120))) for i, a in enumerate(az)]


def test_kept_frames_are_spread_by_at_least_six_degrees() -> None:
    choice = choose_keyframes(_sweep(200, 150.0), max_keyframes=100)
    assert _gaps(choice.azimuths_deg).min() >= MIN_SEPARATION_DEG - 1e-9
    assert len(choice.frame_ids) >= 150.0 / (2 * MIN_SEPARATION_DEG)
    assert choice.span_deg == pytest.approx(150.0, abs=2 * MIN_SEPARATION_DEG)


def test_the_sharper_frame_in_a_bin_wins() -> None:
    cands = [Candidate(0, 10.5, 50.0), Candidate(1, 11.0, 90.0), Candidate(2, 40.0, 70.0),
             Candidate(3, 70.0, 70.0)]  # fmt: skip
    choice = choose_keyframes(cands)
    assert 1 in choice.frame_ids and 0 not in choice.frame_ids


def test_a_sharper_neighbour_across_a_bin_edge_still_blocks() -> None:
    # 11.9 and 12.1 sit in different 6-degree bins but are 0.2 degrees apart.
    choice = choose_keyframes([Candidate(0, 11.9, 50.0), Candidate(1, 12.1, 90.0)])
    assert choice.frame_ids == (1,)


def test_blurry_frames_are_dropped() -> None:
    cands = _sweep(30, 150.0)
    cands[5] = Candidate(5, cands[5].azimuth_deg, 10.0)  # below 0.35 x median (~100)
    cands[6] = Candidate(6, cands[6].azimuth_deg, 34.0)
    choice = choose_keyframes(cands)
    assert choice.blurry == 2 and 5 not in choice.frame_ids and 6 not in choice.frame_ids
    assert choice.sharpness_threshold == pytest.approx(
        0.35 * np.median([c.sharpness for c in cands])
    )
    assert choice.candidates == 30


def test_cap_thins_evenly_and_keeps_the_ends() -> None:
    cands = _sweep(100, 160.0)
    full = choose_keyframes(cands, max_keyframes=1000)
    capped = choose_keyframes(cands, max_keyframes=8)
    assert len(full.frame_ids) > 8 and len(capped.frame_ids) == 8
    assert capped.azimuths_deg[0] == full.azimuths_deg[0]
    assert capped.azimuths_deg[-1] == full.azimuths_deg[-1]
    assert capped.span_deg == pytest.approx(full.span_deg)
    assert list(capped.azimuths_deg) == sorted(capped.azimuths_deg)


def test_default_cap_is_twenty_four() -> None:
    assert len(choose_keyframes(_sweep(300, 300.0)).frame_ids) == 24


def test_arc_across_the_back_wraps() -> None:
    az = [170.0, 178.0, -175.0, -167.0, -160.0]
    cands = [Candidate(i, a, 100.0) for i, a in enumerate(az)]
    choice = choose_keyframes(cands)
    assert choice.azimuths_deg == (170.0, 178.0, -175.0, -167.0, -160.0)
    assert choice.span_deg == pytest.approx(30.0)
    assert span_deg([170.0, -170.0]) == pytest.approx(20.0)


def test_empty_and_bad_cap() -> None:
    assert choose_keyframes([]).frame_ids == ()
    with pytest.raises(ValueError, match="at least 1"):
        choose_keyframes(_sweep(3, 30.0), max_keyframes=0)


def test_azimuth_is_measured_around_the_vertical_line() -> None:
    centers = np.array([[0.0, 5.0, 1.0], [1.0, -3.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, -1.0]])
    az = azimuths_deg(centers + [2.0, 0.0, 3.0], np.array([2.0, 9.0, 3.0]))
    assert az == pytest.approx([0.0, 90.0, -90.0, 180.0])
