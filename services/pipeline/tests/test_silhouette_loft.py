"""The silhouette loft: neighbouring rings must be joined vertex to vertex.

np.linalg.eigh may return an eigenvector pair negated, or swapped where the two
semi-axes cross; lofting from that factor turns the ring start half or a quarter
turn between neighbouring rings, and the side faces of that band cut through the
leg while the mesh stays watertight. These pin the ring correspondence and the
sections a measuring slice would read there.
"""

from __future__ import annotations

import numpy as np
import trimesh
from scipy.spatial import ConvexHull

from forms_pipeline.reconstruct.silhouette import (
    RING_POINTS,
    SILHOUETTE_VERSION,
    STEP_M,
    _loft,
)

FRAME = (np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, -1.0]), np.array([0.0, 1.0, 0.0]))


def _params(semi: np.ndarray, angle: np.ndarray) -> np.ndarray:
    c, s = np.cos(angle), np.sin(angle)
    rot = np.stack([np.stack([c, -s], -1), np.stack([s, c], -1)], axis=1)
    shape = np.einsum("rij,rj,rkj->rik", rot, semi**2, rot)
    return np.column_stack(
        [np.zeros(len(angle)), np.zeros(len(angle)), shape[:, 0, 0], shape[:, 0, 1], shape[:, 1, 1]]
    )


def _ring_jump(mesh: trimesh.Trimesh, n_rings: int) -> float:
    rings = mesh.vertices[: n_rings * RING_POINTS].reshape(n_rings, RING_POINTS, 3)
    return float(np.linalg.norm(rings[1:] - rings[:-1], axis=2).max())


def _section_areas(mesh: trimesh.Trimesh, heights: np.ndarray) -> np.ndarray:
    """Convex-hull area of the horizontal section at each height (segment.width_profile's
    reading); faces that cut through the leg pull section points inside the outline."""
    lines, _, _ = trimesh.intersections.mesh_multiplane(
        mesh, plane_origin=[0.0, 0.0, 0.0], plane_normal=[0.0, 1.0, 0.0], heights=heights
    )
    return np.array([ConvexHull(np.asarray(seg).reshape(-1, 2)).volume for seg in lines])


def test_a_turning_ellipse_lofts_without_a_half_turn() -> None:
    n = 200
    semi = np.tile([0.05, 0.035], (n, 1))
    s = np.arange(n) * STEP_M
    mesh = _loft(s, _params(semi, np.linspace(0.0, np.pi, n)), np.zeros(3), FRAME)
    assert mesh.is_watertight
    # The ellipse turns 0.9 degrees per ring: a vertex moves well under a millimeter.
    assert _ring_jump(mesh, n) < 0.003
    heights = s[:-1] + STEP_M / 2  # every band between neighbouring rings
    assert np.allclose(_section_areas(mesh, heights), np.pi * 0.05 * 0.035, rtol=0.01)


def test_semi_axes_crossing_do_not_swap_the_ring_start() -> None:
    n = 120
    a = np.linspace(0.045, 0.035, n)
    semi = np.column_stack([a, a[::-1]])  # mediolateral and front-back cross mid-way
    s = np.arange(n) * STEP_M
    mesh = _loft(s, _params(semi, np.full(n, 0.3)), np.zeros(3), FRAME)
    assert mesh.is_watertight
    assert _ring_jump(mesh, n) < 0.003
    heights = s[:-1] + STEP_M / 2
    expected = np.pi * np.interp(heights, s, a * a[::-1])
    assert np.allclose(_section_areas(mesh, heights), expected, rtol=0.01)


def test_loft_keeps_outward_winding() -> None:
    n = 30
    semi = np.tile([0.05, 0.035], (n, 1))
    mesh = _loft(np.arange(n) * STEP_M, _params(semi, np.full(n, 0.2)), np.zeros(3), FRAME)
    assert mesh.volume > 0


def test_silhouette_version_is_a_string() -> None:
    assert isinstance(SILHOUETTE_VERSION, str) and SILHOUETTE_VERSION
