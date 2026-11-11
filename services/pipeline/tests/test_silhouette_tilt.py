"""MAX_TILT_DEG is a posture rule, not a limit of the math (up to 40 degrees).

With the gate opened for the test only, a shin tilted 40 degrees from vertical is
measured within the same bounds as an upright one: the clean-capture 2%, and under
ARKit-sized pose and mask noise the noisy-capture ceilings. Observed 2026-11-11: clean
worst 1.4%; noisy (seed 12) worst 5.0%, median 1.6%. At 45 degrees the noisy worst
reached 6.03%, past the ceiling, so 40 is the bound this pins. Whether to relax the
production gate is Liam's call (TODO(liam) in the round-2 report).
"""

from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest
from test_silhouette import (
    FLOOR_Y,
    NOISY_MEDIAN_TOLERANCE,
    NOISY_TOLERANCE,
    jitter_mask,
    jitter_pose,
    measured,
    relative_errors,
    views,
)

from forms_pipeline.reconstruct import ReconstructionQualityError, silhouette
from forms_pipeline.reconstruct.silhouette import reconstruct_silhouette

TILT_DEG = 40.0


def test_the_gate_still_refuses_a_forty_degree_shin() -> None:
    with pytest.raises(ReconstructionQualityError, match="Keep your shin upright"):
        reconstruct_silhouette(views(TILT_DEG), floor_y=FLOOR_Y)


def test_a_forty_degree_shin_measures_within_the_upright_bounds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(silhouette, "MAX_TILT_DEG", 45.0)
    clean = reconstruct_silhouette(views(TILT_DEG), floor_y=FLOOR_Y)
    assert clean.artifacts["axis_tilt_deg"] == pytest.approx(TILT_DEG, abs=1.0)
    errors = relative_errors(measured(clean.mesh))
    assert max(errors.values()) < 0.02, errors

    rng = np.random.default_rng(12)
    noisy = [
        replace(
            v, camera_to_world=jitter_pose(v.camera_to_world, rng), mask=jitter_mask(v.mask, rng)
        )
        for v in views(TILT_DEG)
    ]
    errors = relative_errors(measured(reconstruct_silhouette(noisy, floor_y=FLOOR_Y).mesh))
    assert max(errors.values()) < NOISY_TOLERANCE, errors
    assert float(np.median(list(errors.values()))) < NOISY_MEDIAN_TOLERANCE, errors
