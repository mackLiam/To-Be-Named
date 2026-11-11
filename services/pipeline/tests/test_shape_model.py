"""shape/model.py: grid, index map, contours, and the 25-value projection.

All legs here are synthetic. `synthetic_state` and `loft_mesh` are shared with
the other test_shape_* modules.
"""

from __future__ import annotations

import numpy as np
import pytest
import trimesh
from shapely.geometry import LinearRing, Polygon

from forms_pipeline.contract import MEASUREMENT_KEYS
from forms_pipeline.extraction.measure import extract_measurements
from forms_pipeline.shape.model import (
    ESTIMATOR_VERSION,
    FIT_CRITICAL_KEYS,
    GRID_T,
    IDX_L,
    INNER_KEYS,
    LEG_LENGTH_KEY,
    N_STATE,
    SLICE_K,
    K,
    complete_values,
    contour,
    depths_mm,
    index_of,
    key_for_index,
    label,
    project,
    projection_jacobian,
    ring_extents,
    signed_area,
    state_from_mm,
    state_index,
    widths_mm,
)


def synthetic_state(
    leg_length_mm: float = 400.0, width_scale: float = 1.0, depth_ratio: float = 0.8
) -> np.ndarray:
    """A synthetic leg: narrow ankle, calf bulge, wider at the knee, wider than deep."""
    t = GRID_T
    w = width_scale * (70.0 + 30.0 * np.sin(np.pi * 0.9 * t))
    return state_from_mm(leg_length_mm, w, depth_ratio * w)


def loft_mesh(x: np.ndarray, points: int = 256, t_step: float = 0.05) -> trimesh.Trimesh:
    """Open tube lofted through the state's elliptical rings (mm), ankle at z = 0.

    Rings at GRID_T come straight from the state; intermediate rings (when
    t_step < 0.05) interpolate log w and log d linearly.
    """
    ts = np.round(np.arange(0.0, 1.0 + 1e-9, t_step), 10)
    lw = np.interp(ts, GRID_T, np.log(widths_mm(x)))
    ld = np.interp(ts, GRID_T, np.log(depths_mm(x)))
    length = float(np.exp(x[IDX_L]))
    rings = [
        np.column_stack([contour(np.exp(a), np.exp(b), points), np.full(points, t * length)])
        for t, a, b in zip(ts, lw, ld, strict=True)
    ]
    verts = np.vstack(rings)
    n = len(ts)
    ids = np.arange(n * points).reshape(n, points)
    a0, b0 = ids[:-1], np.roll(ids[:-1], -1, 1)
    c0, d0 = ids[1:], np.roll(ids[1:], -1, 1)
    faces = np.vstack(
        [
            np.column_stack([a0.ravel(), b0.ravel(), c0.ravel()]),
            np.column_stack([b0.ravel(), d0.ravel(), c0.ravel()]),
        ]
    )
    return trimesh.Trimesh(vertices=verts, faces=faces, process=False)


def test_version_and_grid() -> None:
    assert ESTIMATOR_VERSION == "0.1.0"
    assert K == 21 and N_STATE == 43
    assert np.array_equal(GRID_T, np.arange(21) / 20)
    assert SLICE_K == {"S1": 4, "S2": 8, "S3": 12, "S4": 16}
    with pytest.raises(ValueError):
        GRID_T[0] = 1.0  # read-only


def test_key_sets_derive_from_schema() -> None:
    assert LEG_LENGTH_KEY in MEASUREMENT_KEYS
    assert len(FIT_CRITICAL_KEYS) == 9 and len(INNER_KEYS) == 16
    assert set(FIT_CRITICAL_KEYS) | set(INNER_KEYS) == set(MEASUREMENT_KEYS)
    assert all(k == LEG_LENGTH_KEY or k.endswith(("_OW", "_OD")) for k in FIT_CRITICAL_KEYS)


def test_state_index_map_round_trips() -> None:
    seen = set()
    for i in range(N_STATE):
        component, k = label(i)
        assert index_of(component, k) == i
        seen.add((component, k))
    assert len(seen) == N_STATE
    assert label(0) == ("log_L", None)
    assert label(1) == ("log_w", 0) and label(21) == ("log_w", 20)
    assert label(22) == ("log_d", 0) and label(42) == ("log_d", 20)
    for key in FIT_CRITICAL_KEYS:
        assert key_for_index(state_index(key)) == key
    assert state_index("S1_OW") == 1 + 4 and state_index("S4_OD") == 22 + 16
    assert key_for_index(1) is None  # t = 0 is not a slice
    for bad in (-1, N_STATE):
        with pytest.raises(IndexError):
            label(bad)
    for comp, k in (("log_L", 0), ("log_w", None), ("log_w", 21), ("log_x", 3)):
        with pytest.raises(KeyError):
            index_of(comp, k)
    with pytest.raises(KeyError):
        state_index("S1_ISW")


def test_state_from_mm_round_trips_and_rejects_bad_shapes() -> None:
    w, d = np.linspace(60, 90, K), np.linspace(50, 80, K)
    x = state_from_mm(380.0, w, d)
    assert x.shape == (N_STATE,)
    np.testing.assert_allclose(widths_mm(x), w, rtol=1e-12)
    np.testing.assert_allclose(depths_mm(x), d, rtol=1e-12)
    with pytest.raises(ValueError):
        state_from_mm(380.0, w[:-1], d)


def test_projection_is_the_symmetric_split() -> None:
    x = synthetic_state()
    values = project(x)
    assert list(values) == list(MEASUREMENT_KEYS)
    assert values[LEG_LENGTH_KEY] == pytest.approx(400.0, rel=1e-12)
    for s, k in SLICE_K.items():
        ow, od = widths_mm(x)[k], depths_mm(x)[k]
        assert values[f"{s}_OW"] == pytest.approx(ow, rel=1e-12)
        assert values[f"{s}_OD"] == pytest.approx(od, rel=1e-12)
        assert values[f"{s}_ISW"] == values[f"{s}_ICW"] == values[f"{s}_OW"] / 2
        assert values[f"{s}_ISD"] == values[f"{s}_ICD"] == values[f"{s}_OD"]
    assert complete_values({k: values[k] for k in FIT_CRITICAL_KEYS}) == values


def test_projection_jacobian_matches_finite_differences() -> None:
    x = synthetic_state()
    jac = projection_jacobian(x)
    base = np.array(list(project(x).values()))
    eps = 1e-6
    for i in range(N_STATE):
        dx = np.zeros(N_STATE)
        dx[i] = eps
        fd = (np.array(list(project(x + dx).values())) - base) / eps
        np.testing.assert_allclose(jac[:, i], fd, rtol=1e-4, atol=1e-6)


@pytest.mark.parametrize("w,d", [(80.0, 60.0), (60.0, 80.0), (70.0, 70.0), (31.0, 219.0)])
@pytest.mark.parametrize("n", [48, 256])
def test_contours_closed_convex_counter_clockwise(w: float, d: float, n: int) -> None:
    pts = contour(w, d, n)
    assert pts.shape == (n, 2)
    ring = LinearRing(pts)
    assert ring.is_closed and ring.is_simple and Polygon(pts).is_valid
    assert not np.any(np.all(np.diff(pts, axis=0, append=pts[:1]) == 0, axis=1))
    edges = np.roll(pts, -1, axis=0) - pts
    nxt = np.roll(edges, -1, axis=0)
    cross = edges[:, 0] * nxt[:, 1] - edges[:, 1] * nxt[:, 0]
    assert np.all(cross > 0)  # strictly convex and turning left everywhere
    assert signed_area(pts) > 0
    assert signed_area(pts[::-1]) < 0
    assert signed_area(pts) == pytest.approx(np.pi * w * d / 4, rel=0.01)


@pytest.mark.parametrize("w,d", [(80.0, 60.0), (60.0, 80.0), (99.3, 77.7)])
def test_ring_extents_equal_width_and_depth(w: float, d: float) -> None:
    ew, ed = ring_extents(contour(w, d))
    assert ew == pytest.approx(w, abs=1e-12)
    assert ed == pytest.approx(d, abs=1e-12)
    pts = contour(w, d)
    assert pts[12].tolist() == [0.0, d / 2]  # quarter turn is the exact anterior point


@pytest.mark.parametrize("n", [0, 2, 47, 50])
def test_contour_rejects_point_counts_not_multiple_of_four(n: int) -> None:
    with pytest.raises(ValueError):
        contour(80.0, 60.0, n)


@pytest.mark.parametrize("t_step", [0.05, 0.0125])
def test_extraction_on_lofted_rings_matches_projection(t_step: float) -> None:
    x = synthetic_state(leg_length_mm=410.0, width_scale=1.1)
    result = extract_measurements(loft_mesh(x, t_step=t_step))
    expected = project(x)
    for key in MEASUREMENT_KEYS:
        assert result.values[key] == pytest.approx(expected[key], abs=0.5), key
