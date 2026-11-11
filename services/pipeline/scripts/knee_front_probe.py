"""Probe: does the front edge of a bent leg keep the knee dip? (SCAN-V3-PLAN.md 5.1)

Slices the synthetic hinged leg's truth solid (tests/bent_knee_synth.py) across the
shin and prints, per flexion, the first local minimum above 0.40 m of the front
extent (+z) and of the equivalent diameter, against the true knee height. Synthetic
geometry only, no body data. Run from services/pipeline:

    .venv/bin/python scripts/knee_front_probe.py

Result on 2026-11-11: the front-edge minimum sat 7.5 mm below the true knee at 45 to
90 degrees; the width minimum drifted to 37.5 mm low at 90; at 0 degrees the front
edge found a false minimum lower down.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

from bent_knee_synth import inside_bent  # noqa: E402
from test_silhouette import KNEE_H  # noqa: E402

GRID_M = 0.001
HEIGHT_STEP_M = 0.0025
WINDOW = 4  # samples either side for a local minimum
SEARCH_FROM_M = 0.40


def _first_min(values: np.ndarray, heights: np.ndarray) -> float | None:
    for i in range(WINDOW, len(values) - WINDOW):
        window = values[i - WINDOW : i + WINDOW + 1]
        if (
            heights[i] > SEARCH_FROM_M
            and values[i] == np.nanmin(window)
            and values[i] < np.nanmax(values[i:])
        ):
            return float(heights[i])
    return None


def main() -> None:
    xs = np.arange(-0.12, 0.12, GRID_M)
    zs = np.arange(-0.15, 0.20, GRID_M)
    x, z = np.meshgrid(xs, zs, indexing="ij")
    heights = np.arange(0.30, 0.62, HEIGHT_STEP_M)
    for flexion in (0, 45, 60, 75, 90):
        front = np.full(len(heights), np.nan)
        width = np.full(len(heights), np.nan)
        for i, h in enumerate(heights):
            inside = inside_bent(np.stack([x, np.full_like(x, h), z], -1), flexion)
            if inside.any():
                front[i] = z[inside].max()
                width[i] = np.sqrt(4.0 * inside.sum() * GRID_M**2 / np.pi)
        print(
            f"flexion {flexion:2d}: front-edge min {_first_min(front, heights)}, "
            f"width min {_first_min(width, heights)}, true knee {KNEE_H}"
        )


if __name__ == "__main__":
    main()
