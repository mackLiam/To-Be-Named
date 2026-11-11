"""Scale-free harness metrics, mask quality and the agreement math."""

from __future__ import annotations

import numpy as np
import pytest
import trimesh

from forms_pipeline.harness.metrics import (
    PROFILE_KEY,
    agreement,
    mask_stats,
    mask_summary,
    ratios,
    shape_metrics,
    width_profile,
)


def _values(scale: float = 1.0) -> dict[str, float]:
    ow = {"S1": 60.0, "S2": 80.0, "S3": 100.0, "S4": 90.0}
    od = {"S1": 50.0, "S2": 70.0, "S3": 80.0, "S4": 85.0}
    v = {"Leg_Length": 380.0 * scale}
    for s in ow:
        v[f"{s}_OW"], v[f"{s}_OD"] = ow[s] * scale, od[s] * scale
    return v


def test_shape_metrics_ratios() -> None:
    m = shape_metrics(_values())
    assert m["slices"]["S1"]["OD/OW"] == pytest.approx(50 / 60)
    assert m["slices"]["S2"]["OW/OW_S3"] == pytest.approx(0.8)
    assert m["slices"]["S4"]["OD/OD_S3"] == pytest.approx(85 / 80)
    assert m["slices"]["S3"]["OW/OW_S3"] == 1.0
    assert m["Leg_Length/OW_S3"] == pytest.approx(3.8)
    assert m["slices"]["S1"]["nominal_OW_mm"] == 60.0


def test_ratios_are_scale_free_and_drop_nominal_values() -> None:
    a, b = ratios(shape_metrics(_values())), ratios(shape_metrics(_values(3.7)))
    assert a.keys() == b.keys() and len(a) == 13
    assert all(not k.startswith("nominal") and "nominal" not in k for k in a)
    assert all(a[k] == pytest.approx(b[k]) for k in a)


def test_agreement_per_ratio_and_max() -> None:
    a = shape_metrics(_values())
    other = _values()
    other["S2_OD"] = 77.0  # S2 OD/OW 0.875 -> 0.9625, OD/OD_S3 0.875 -> 0.9625
    b = shape_metrics(other)
    a["profile"] = [0.5, 1.0, 0.8]
    b["profile"] = [0.6, 1.0, 0.75]
    result = agreement(a, b)
    assert result["diffs"]["S2 OD/OW"] == pytest.approx(7 / 80)
    assert result["diffs"]["S1 OD/OW"] == 0.0
    assert result["diffs"][PROFILE_KEY] == pytest.approx(0.1)
    assert result["max"] == pytest.approx(0.1) and result["max_key"] == PROFILE_KEY
    del a["profile"]
    assert agreement(a, b)["max"] == pytest.approx(0.0875)
    assert agreement(a, a)["max"] == 0.0


def test_agreement_without_profiles_and_with_nan() -> None:
    a, b = shape_metrics(_values()), shape_metrics(_values(2.0))
    assert PROFILE_KEY not in agreement(a, b)["diffs"]
    a["profile"], b["profile"] = [np.nan, 1.0], [0.5, 0.9]
    assert agreement(a, b)["diffs"][PROFILE_KEY] == pytest.approx(0.1)


def test_mask_stats() -> None:
    mask = np.zeros((40, 30), dtype=np.uint8)
    mask[5:10, 5:10] = 255
    mask[20:40, 0:3] = 200  # touches left and bottom
    mask[1, 20] = 127  # below threshold: ignored
    s = mask_stats(mask)
    assert s.components == 2
    assert s.borders == ("bottom", "left") and s.touches_border
    assert s.area_fraction == pytest.approx((25 + 60) / 1200)
    assert not mask_stats(np.zeros((4, 4), np.uint8)).touches_border


def test_mask_summary() -> None:
    a = mask_stats(np.pad(np.full((4, 4), 255, np.uint8), 2))
    b = mask_stats(np.full((8, 8), 255, np.uint8))
    out = mask_summary(
        {"person": [a, None, b], "foreground": [None, None, None]}, {"right_knee": 2}, 3
    )
    assert out["frames"] == 3
    assert out["person"]["frames_with_mask"] == 2
    assert out["person"]["touching_border_fraction"] == 0.5
    assert out["person"]["touching_side_fraction"]["top"] == 0.5
    assert out["person"]["median_area_fraction"] == pytest.approx((0.25 + 1.0) / 2)
    assert out["foreground"]["frames_with_mask"] == 0
    assert out["foreground"]["median_area_fraction"] is None
    assert out["joints_seen"] == {"right_knee": 2}


def _rings(radii: np.ndarray, heights: np.ndarray, flip_from: int | None = None) -> trimesh.Trimesh:
    """Stacked circular rings joined by quads, like silhouette._loft; rings from
    flip_from on start half a turn round, which makes the joining band cut the inside."""
    th = np.linspace(0, 2 * np.pi, 64, endpoint=False)
    rings = []
    for k, (r, z) in enumerate(zip(radii, heights, strict=True)):
        t = th + (np.pi if flip_from is not None and k >= flip_from else 0.0)
        rings.append(np.column_stack([r * np.cos(t), r * np.sin(t), np.full(64, z)]))
    ids = np.arange(len(rings) * 64).reshape(len(rings), 64)
    a, b = ids[:-1], np.roll(ids[:-1], -1, axis=1)
    c, d = ids[1:], np.roll(ids[1:], -1, axis=1)
    faces = np.vstack([np.column_stack([a.ravel(), b.ravel(), c.ravel()]),
                       np.column_stack([b.ravel(), d.ravel(), c.ravel()])])  # fmt: skip
    return trimesh.Trimesh(np.vstack(rings), faces, process=False)


def test_width_profile_of_a_frustum() -> None:
    """Radius 2 -> 1 over a length of 2: diameters fall linearly, the first is the max."""
    z = np.linspace(0.0, 2.0, 201)
    profile = width_profile(_rings(2.0 - z / 2.0, z), np.array([0.0, 0.0, 1.0]), points=5)
    f = np.linspace(0.005, 0.995, 5)
    assert profile == pytest.approx((2.0 - f) / (2.0 - 0.005), abs=0.005)


def test_width_profile_ignores_a_half_turn_ring_flip() -> None:
    z = np.linspace(0.0, 0.4, 201)
    flipped = _rings(np.full(201, 0.05), z, flip_from=140)  # flip near 0.7 of the length
    assert width_profile(flipped, np.array([0.0, 0.0, 1.0])) == pytest.approx([1.0] * 21, abs=0.01)


def test_width_profile_is_direction_agnostic() -> None:
    z = np.linspace(0.0, 0.4, 201)
    mesh = _rings(np.full(201, 0.05), z)
    rot = trimesh.transformations.rotation_matrix(0.3, [1, 0, 0])
    mesh.apply_transform(rot)
    assert width_profile(mesh, -(rot[:3, :3] @ [0, 0, 1.0])) == pytest.approx([1.0] * 21, abs=0.01)


def test_width_profile_of_a_sparse_mesh_is_nan_not_an_error() -> None:
    mesh = _rings(np.array([1.0, 1.0]), np.array([0.0, 1.0]))
    assert np.isnan(width_profile(mesh, np.array([0.0, 0.0, 1.0]), points=3)[1])
