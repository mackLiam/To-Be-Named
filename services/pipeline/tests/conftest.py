"""Shared fixtures: synthetic mesh geometry, generated in code (no binary fixtures needed
for unit tests -- real hand-verified OBJ scans are a golden-file follow-up, see README).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import trimesh

# Constructed dimensions for the tapered frustum used to approximate a shin.
# Narrow end = ankle-end analog (slice origin, Z=0 after orientation), wide
# end = knee-end analog (see extraction/measure.py module docstring for the
# orientation convention this is designed to exercise).
FRUSTUM_HEIGHT_MM = 400.0
FRUSTUM_WIDE_RX_MM = 60.0
FRUSTUM_WIDE_RY_MM = 45.0
FRUSTUM_NARROW_RX_MM = 35.0
FRUSTUM_NARROW_RY_MM = 28.0
FRUSTUM_SIDES = 64


def make_tapered_frustum(
    height: float,
    wide_rx: float,
    wide_ry: float,
    narrow_rx: float,
    narrow_ry: float,
    sides: int = FRUSTUM_SIDES,
) -> trimesh.Trimesh:
    """An elliptical frustum: a wide elliptical base at z=0 tapering linearly to a
    narrower ellipse at z=height. Approximates a shin's overall taper with a
    known, exactly-computable ground truth at any height fraction.
    """
    theta = np.linspace(0, 2 * np.pi, sides, endpoint=False)
    bottom = np.column_stack([wide_rx * np.cos(theta), wide_ry * np.sin(theta), np.zeros(sides)])
    top = np.column_stack(
        [narrow_rx * np.cos(theta), narrow_ry * np.sin(theta), np.full(sides, height)]
    )
    bottom_center = np.array([[0.0, 0.0, 0.0]])
    top_center = np.array([[0.0, 0.0, height]])
    vertices = np.vstack([bottom, top, bottom_center, top_center])

    bc_idx = 2 * sides
    tc_idx = 2 * sides + 1

    faces = []
    for i in range(sides):
        j = (i + 1) % sides
        b_i, b_j = i, j
        t_i, t_j = sides + i, sides + j
        faces.append([b_i, b_j, t_i])
        faces.append([b_j, t_j, t_i])
        faces.append([bc_idx, b_j, b_i])
        faces.append([tc_idx, t_i, t_j])

    return trimesh.Trimesh(vertices=vertices, faces=np.array(faces), process=False)


def expected_ellipse_radii(fraction: float) -> tuple[float, float]:
    """Ground-truth (rx, ry) at height fraction `fraction` from the narrow
    (ankle-analog) end, matching the extraction's slice-origin convention."""
    rx = FRUSTUM_NARROW_RX_MM + fraction * (FRUSTUM_WIDE_RX_MM - FRUSTUM_NARROW_RX_MM)
    ry = FRUSTUM_NARROW_RY_MM + fraction * (FRUSTUM_WIDE_RY_MM - FRUSTUM_NARROW_RY_MM)
    return rx, ry


@pytest.fixture
def frustum_mesh() -> trimesh.Trimesh:
    return make_tapered_frustum(
        FRUSTUM_HEIGHT_MM,
        FRUSTUM_WIDE_RX_MM,
        FRUSTUM_WIDE_RY_MM,
        FRUSTUM_NARROW_RX_MM,
        FRUSTUM_NARROW_RY_MM,
    )


@pytest.fixture
def frustum_mesh_meters() -> trimesh.Trimesh:
    """Same shape as `frustum_mesh`, scaled by 1/1000 so its bounding box reads as
    plausible meters rather than millimeters (triggers the scale heuristic)."""
    scale = 1.0 / 1000.0
    return make_tapered_frustum(
        FRUSTUM_HEIGHT_MM * scale,
        FRUSTUM_WIDE_RX_MM * scale,
        FRUSTUM_WIDE_RY_MM * scale,
        FRUSTUM_NARROW_RX_MM * scale,
        FRUSTUM_NARROW_RY_MM * scale,
    )


@pytest.fixture
def frustum_height_mm() -> float:
    return FRUSTUM_HEIGHT_MM


@pytest.fixture
def ellipse_radii_at():
    """Fixture exposing `expected_ellipse_radii` for tests, without relying on a
    `tests.conftest` import (pytest's default "prepend" import mode does not put
    `services/pipeline` itself on sys.path, only the `tests/` directory)."""
    return expected_ellipse_radii


@pytest.fixture
def degenerate_mesh() -> trimesh.Trimesh:
    """A mesh collapsed to a single point: zero-area faces, no usable geometry."""
    vertices = np.zeros((4, 3))
    faces = np.array([[0, 1, 2], [1, 2, 3]])
    return trimesh.Trimesh(vertices=vertices, faces=faces, process=False)


@pytest.fixture
def frustum_obj_path(tmp_path: Path, frustum_mesh: trimesh.Trimesh) -> Path:
    path = tmp_path / "frustum.obj"
    frustum_mesh.export(path)
    return path


@pytest.fixture
def degenerate_obj_path(tmp_path: Path, degenerate_mesh: trimesh.Trimesh) -> Path:
    path = tmp_path / "degenerate.obj"
    degenerate_mesh.export(path)
    return path
