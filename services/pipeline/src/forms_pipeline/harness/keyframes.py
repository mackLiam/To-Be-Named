"""Azimuth keyframe choice, mirroring docs/SCAN-V3-PLAN.md section 5.2. Pure numpy.

A frame is kept only if it is sharp enough and at least MIN_SEPARATION_DEG of
azimuth (around the vertical line through the leg) from every kept frame; within
one azimuth bin the sharper frame wins. The phone runs this as a stream with a
cap of 36; offline the cap thins the kept set evenly along the arc so the
covered span, which the silhouette span gate reads, is never cut.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from forms_pipeline.reconstruct.segment import angular_span_deg

MIN_SEPARATION_DEG = 6.0
SHARPNESS_FRACTION = 0.35  # of the median sharpness of the candidates
DEFAULT_MAX_KEYFRAMES = 24


@dataclass(frozen=True)
class Candidate:
    frame_id: int
    azimuth_deg: float  # in (-180, 180]
    sharpness: float


@dataclass(frozen=True)
class KeyframeChoice:
    frame_ids: tuple[int, ...]  # ordered along the arc
    azimuths_deg: tuple[float, ...]
    span_deg: float
    sharpness_threshold: float
    candidates: int
    blurry: int


def azimuths_deg(centers: np.ndarray, leg: np.ndarray) -> np.ndarray:
    """Azimuth of each camera center (N, 3) around the vertical (+Y) line through leg."""
    d = np.asarray(centers) - np.asarray(leg)
    return np.degrees(np.arctan2(d[:, 0], d[:, 2]))


def _circular_gap(a: np.ndarray, b: float) -> np.ndarray:
    return np.abs((a - b + 180.0) % 360.0 - 180.0)


def span_deg(azimuths: Sequence[float]) -> float:
    rad = np.radians(np.asarray(azimuths, dtype=np.float64))
    return angular_span_deg(np.column_stack([np.cos(rad), np.sin(rad)]), np.zeros(2))


def _arc_order(az: np.ndarray) -> np.ndarray:
    """Indices of az sorted along the arc, starting after the largest gap."""
    order = np.argsort(az)
    gaps = np.diff(np.append(az[order], az[order][0] + 360.0))
    return np.roll(order, -(int(np.argmax(gaps)) + 1))


def choose_keyframes(
    candidates: Sequence[Candidate],
    max_keyframes: int = DEFAULT_MAX_KEYFRAMES,
    min_separation_deg: float = MIN_SEPARATION_DEG,
    sharpness_fraction: float = SHARPNESS_FRACTION,
) -> KeyframeChoice:
    if max_keyframes < 1:
        raise ValueError("max_keyframes must be at least 1")
    if not candidates:
        return KeyframeChoice((), (), 0.0, 0.0, 0, 0)
    sharp = np.array([c.sharpness for c in candidates], dtype=np.float64)
    threshold = sharpness_fraction * float(np.median(sharp))
    pool = [c for c in candidates if c.sharpness >= threshold]

    best_in_bin: dict[int, Candidate] = {}
    for c in pool:
        b = int(np.floor((c.azimuth_deg + 180.0) / min_separation_deg))
        held = best_in_bin.get(b)
        if held is None or c.sharpness > held.sharpness:
            best_in_bin[b] = c
    kept: list[Candidate] = []
    for c in sorted(best_in_bin.values(), key=lambda c: (-c.sharpness, c.frame_id)):
        kept_az = np.array([k.azimuth_deg for k in kept])
        if not kept or _circular_gap(kept_az, c.azimuth_deg).min() >= min_separation_deg:
            kept.append(c)

    az = np.array([k.azimuth_deg for k in kept])
    order = _arc_order(az)
    if len(order) > max_keyframes:
        order = order[np.round(np.linspace(0, len(order) - 1, max_keyframes)).astype(int)]
    chosen = [kept[i] for i in order]
    return KeyframeChoice(
        frame_ids=tuple(c.frame_id for c in chosen),
        azimuths_deg=tuple(float(c.azimuth_deg) for c in chosen),
        span_deg=span_deg([c.azimuth_deg for c in chosen]),
        sharpness_threshold=threshold,
        candidates=len(candidates),
        blurry=len(candidates) - len(pool),
    )
