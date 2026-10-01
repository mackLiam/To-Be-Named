"""Synthetic captures for the reconstruct tests: camera rings, legs, bundles, JPEGs.

Imported by the other test_reconstruct_*.py modules (pytest's prepend import mode
puts tests/ on sys.path). Ground truth below is in ARKit world: meters, Y up.
"""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import trimesh
from scipy.spatial.transform import Rotation

from forms_pipeline.reconstruct.align import CAMERA_TO_WORLD

LEG_CENTER_XZ = (0.30, -0.20)
ANKLE_Y = 0.09
KNEE_Y = 0.46
EXPECTED_LEG_LENGTH_MM = (KNEE_Y - ANKLE_Y) * 1000.0
# (height, radius) control points of the shin tube: ankle minimum, calf maximum,
# knee narrowing, thigh widening.
LEG_PROFILE = ((0.05, 0.040), (ANKLE_Y, 0.033), (0.22, 0.055), (KNEE_Y, 0.042), (0.62, 0.065))
NO_KNEE_PROFILE = ((0.05, 0.040), (ANKLE_Y, 0.033), (0.22, 0.055), (0.62, 0.055))


def look_at(position: np.ndarray, target: np.ndarray) -> np.ndarray:
    """ARKit-style camera-to-world: camera looks down its -Z, Y roughly up."""
    z = position - target
    z /= np.linalg.norm(z)
    x = np.cross([0.0, 1.0, 0.0], z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, z, position
    return m


def camera_ring(n: int = 40, radius: float = 0.45) -> dict[str, np.ndarray]:
    cx, cz = LEG_CENTER_XZ
    cams = {}
    for i in range(n):
        a = 2 * np.pi * i / n
        pos = np.array([cx + radius * np.cos(a), 0.30 if i % 2 else 0.50, cz + radius * np.sin(a)])
        cams[f"{i:03d}.jpg"] = look_at(pos, np.array([cx, 0.30, cz]))
    return cams


def camera_arc(span_deg: float, n: int = 30, taper_m: float = 0.0) -> dict[str, np.ndarray]:
    """A solo user's partial orbit centered on +X, radius 0.45 shrinking by taper_m at the ends.

    A taper (the user's reach shortening at the sides) keeps the path smooth but
    pulls a circle fit's center well away from the leg.
    """
    cx, cz = LEG_CENTER_XZ
    t = np.linspace(-1.0, 1.0, n)
    cams = {}
    for i, ti in enumerate(t):
        a, r = np.radians(span_deg / 2 * ti), 0.45 - taper_m * ti**2
        pos = np.array([cx + r * np.cos(a), 0.30 if i % 2 else 0.50, cz + r * np.sin(a)])
        cams[f"{i:03d}.jpg"] = look_at(pos, np.array([cx, 0.30, cz]))
    return cams


def capture_info(**overrides: Any) -> dict[str, Any]:
    """A valid capture v2 "capture" object anchored on the synthetic leg axis."""
    cx, cz = LEG_CENTER_XZ
    info = {
        "mode": "solo",
        "anchor_world": [cx, 0.30, cz],
        "front_azimuth_rad": 0.0,
        "coverage": 0.6,
        "finished_early": False,
    }
    info.update(overrides)
    return info


def similarity(seed: int = 0) -> tuple[float, np.ndarray, np.ndarray]:
    """A known photogrammetry -> ARKit similarity (s, R, t)."""
    rot = Rotation.random(random_state=seed).as_matrix()
    return 0.37, rot, np.array([1.5, -0.4, 2.2])


def to_photo_points(points: np.ndarray, s: float, rot: np.ndarray, t: np.ndarray) -> np.ndarray:
    return (points - t) @ rot / s


def to_photo_poses(
    arkit: dict[str, np.ndarray],
    s: float,
    rot: np.ndarray,
    t: np.ndarray,
    convention: str = CAMERA_TO_WORLD,
    noise_m: float = 0.0,
    seed: int = 1,
) -> dict[str, np.ndarray]:
    """Express ARKit cameras in the photogrammetry frame, optionally noisy (ARKit meters)."""
    rng = np.random.default_rng(seed)
    out = {}
    for name, c2w in arkit.items():
        pos = c2w[:3, 3] + rng.normal(0.0, noise_m, 3)
        m = np.eye(4)
        m[:3, :3] = rot.T @ c2w[:3, :3]
        m[:3, 3] = to_photo_points(pos[None], s, rot, t)[0]
        out[name] = m if convention == CAMERA_TO_WORLD else np.linalg.inv(m)
    return out


def _grid(size: float, step: float, y: float, cx: float, cz: float) -> trimesh.Trimesh:
    n = int(size / step) + 1
    xs = np.linspace(cx - size / 2, cx + size / 2, n)
    zs = np.linspace(cz - size / 2, cz + size / 2, n)
    gx, gz = np.meshgrid(xs, zs)
    verts = np.column_stack([gx.ravel(), np.full(gx.size, y), gz.ravel()])
    idx = np.arange(n * n).reshape(n, n)
    a, b, c, d = idx[:-1, :-1], idx[:-1, 1:], idx[1:, :-1], idx[1:, 1:]
    faces = np.vstack([np.column_stack([a.ravel(), c.ravel(), b.ravel()]),
                       np.column_stack([b.ravel(), c.ravel(), d.ravel()])])  # fmt: skip
    return trimesh.Trimesh(verts, faces, process=False)


def _tube(
    profile: tuple[tuple[float, float], ...], cx: float, cz: float, arc_deg: float = 360.0
) -> trimesh.Trimesh:
    """Closed tube, or an open shell spanning arc_deg centered on +X (the covered front)."""
    ys = np.arange(profile[0][0], profile[-1][0] + 1e-9, 0.002)
    radii = np.interp(ys, [p[0] for p in profile], [p[1] for p in profile])
    sides = 48
    closed = arc_deg >= 360.0
    half = np.radians(arc_deg) / 2
    theta = (
        np.linspace(0, 2 * np.pi, sides, endpoint=False)
        if closed
        else np.linspace(-half, half, sides)
    )
    verts = np.array(
        [
            [cx + r * np.cos(a), y, cz + r * np.sin(a)]
            for y, r in zip(ys, radii, strict=True)
            for a in theta
        ]
    )
    faces = []
    for i in range(len(ys) - 1):
        for j in range(sides if closed else sides - 1):
            a, b = i * sides + j, i * sides + (j + 1) % sides
            faces += [[a, b + sides, b], [a, a + sides, b + sides]]
    return trimesh.Trimesh(verts, np.array(faces), process=False)


def _box(
    extents: tuple[float, float, float], center: tuple[float, float, float]
) -> trimesh.Trimesh:
    box = trimesh.creation.box(extents=extents)
    box.apply_translation(center)
    verts, faces = trimesh.remesh.subdivide_to_size(box.vertices, box.faces, max_edge=0.01)
    return trimesh.Trimesh(verts, faces, process=False)


def make_leg_scene(
    profile: tuple[tuple[float, float], ...] = LEG_PROFILE,
    foot: bool = True,
    floor: bool = True,
    arc_deg: float = 360.0,
) -> trimesh.Trimesh:
    """Floor plane + foot block + shin tube + a background box outside the orbit radius.

    arc_deg < 360 leaves the back of the shin unreconstructed, as in a solo capture.
    """
    cx, cz = LEG_CENTER_XZ
    parts = [_tube(profile, cx, cz, arc_deg), _box((0.10, 0.10, 0.10), (cx + 0.32, 0.05, cz))]
    if foot:
        parts.append(_box((0.09, 0.07, 0.24), (cx, 0.035, cz + 0.06)))
    if floor:
        parts.append(_grid(0.8, 0.01, 0.0, cx, cz))
    return trimesh.util.concatenate(parts)


def _column_major(m: np.ndarray) -> list[float]:
    return [float(v) for v in m.T.ravel()]


def capture_doc(
    cameras: dict[str, np.ndarray] | None = None,
    width: int = 1920,
    height: int = 1440,
    capture: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cameras = cameras if cameras is not None else camera_ring()
    doc: dict[str, Any] = {
        "format": "forms.photo-capture",
        "version": 1,
        "device": {"model": "iPhone17,3", "os": "26.6.1"},
        "images": [
            {
                "file": name,
                "timestamp": 1.0 + i * 0.5,
                "camera_to_world": _column_major(m),
                "intrinsics": [1400.0, 1400.0, width / 2, height / 2],
                "width": width,
                "height": height,
                "tracking": "normal",
            }
            for i, (name, m) in enumerate(sorted(cameras.items()))
        ],
    }
    if capture is not None:
        doc["capture"] = capture
    return doc


def capture_bytes(doc: dict[str, Any]) -> bytes:
    return json.dumps(doc).encode()


def fake_jpeg(width: int = 1920, height: int = 1440, sof: int = 0xC0) -> bytes:
    """Minimal JPEG header stream: SOI, APP0, COM with fill bytes, SOFn, EOI."""
    app0 = b"\xff\xe0" + (16).to_bytes(2, "big") + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    com = b"\xff\xff\xfe" + (6).to_bytes(2, "big") + b"test"
    comps = b"\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    frame = b"\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x03" + comps
    sof_seg = bytes([0xFF, sof]) + (2 + len(frame)).to_bytes(2, "big") + frame
    return b"\xff\xd8" + app0 + com + sof_seg + b"\xff\xd9"


def write_obj(mesh: trimesh.Trimesh) -> bytes:
    return trimesh.exchange.obj.export_obj(mesh, include_normals=False).encode()


def test_camera_ring_matrices_are_rigid() -> None:
    for m in camera_ring(8).values():
        assert np.allclose(m[:3, :3] @ m[:3, :3].T, np.eye(3), atol=1e-9)
        assert np.isclose(np.linalg.det(m[:3, :3]), 1.0)


def test_fake_jpeg_round_trips_through_parser() -> None:
    from forms_pipeline.reconstruct.bundle import jpeg_dimensions

    assert jpeg_dimensions(fake_jpeg(640, 480)) == (640, 480)
