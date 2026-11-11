"""Synthetic forms.video-bundle v1 writer for the harness tests.

The truth leg of test_silhouette (tapered rotated ellipses with a foot, calf and
knee, standing on the floor at y = 0) is ray-cast into small portrait masks from
upright cameras on a front arc, plus a point cloud of leg surface, floor and a
little clutter. A random similarity (scale 0.2 to 5, any rotation, any
translation) then moves everything into "session units", and each camera pose is
written in one of the four conventions the harness must resolve.
"""

from __future__ import annotations

import functools
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from scipy import ndimage
from scipy.spatial.transform import Rotation
from test_reconstruct_synthetic import fake_jpeg
from test_silhouette import ELLIPSE_ANGLE_RAD, TOP_H, encode_png, section

from forms_pipeline.harness.frame import Camera, assumed_intrinsics, rigid_inverse
from forms_pipeline.reconstruct.silhouette import project, ray_directions

WIDTH, HEIGHT = 240, 320  # portrait, like a 720x1280 phone video scaled down
INTRINSICS = assumed_intrinsics(WIDTH, HEIGHT)
CAMERA_DISTANCE_M = 0.6  # horizontal, from the leg axis
CAMERA_HEIGHT_M = 0.36
TARGET_HEIGHT_M = 0.29
ARC_DEG = 150.0
RENDER_SAMPLES = 160
BOUND_R = 0.2
COARSE_PX = 2
CONVENTIONS = ("c2w_arkit", "c2w_opencv", "w2c_arkit", "w2c_opencv")
_FLIP = np.diag([1.0, -1.0, -1.0, 1.0])
_ROLL_HALF_TURN = np.diag([-1.0, -1.0, 1.0, 1.0])  # about the viewing axis


# --- truth scene -------------------------------------------------------------------------


def upright_camera(position: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Phone upright, image up near world up, looking at target (silhouette convention)."""
    back = position - target
    back /= np.linalg.norm(back)
    x = np.cross([0.0, 1.0, 0.0], back)
    x /= np.linalg.norm(x)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, np.cross(back, x), back, position
    return m


def _inside_leg(c2w: np.ndarray, pix: np.ndarray) -> np.ndarray:
    """Does each pixel's ray pass through the solid truth leg (upright, base at origin)?"""
    origin = c2w[:3, 3]
    c, s = np.cos(ELLIPSE_ANGLE_RAD), np.sin(ELLIPSE_ANGLE_RAD)
    d = ray_directions(c2w, INTRINSICS, pix)
    qa = d[:, 0] ** 2 + d[:, 2] ** 2
    qb = 2 * (origin[0] * d[:, 0] + origin[2] * d[:, 2])
    qc = origin[0] ** 2 + origin[2] ** 2 - BOUND_R**2
    disc = qb**2 - 4 * qa * qc
    hit = disc > 0
    root = np.sqrt(np.where(hit, disc, 0.0))
    t0, t1 = (-qb - root) / (2 * qa), (-qb + root) / (2 * qa)
    ts = t0[:, None] + (t1 - t0)[:, None] * np.linspace(0, 1, RENDER_SAMPLES)[None]
    p = origin + ts[..., None] * d[:, None, :]
    h = p[..., 1]
    a, b, cx, cz = section(h)
    dx, dz = p[..., 0] - cx, p[..., 2] - cz
    lx, lz = c * dx + s * dz, -s * dx + c * dz
    inside = ((lx / a) ** 2 + (lz / b) ** 2 <= 1.0) & (h >= 0.0) & (h <= TOP_H)
    return inside.any(axis=1) & hit


def render_mask(c2w: np.ndarray) -> np.ndarray:
    """255 where a pixel ray passes through the leg: coarse grid, exact near the edges."""
    gu, gv = np.meshgrid(np.arange(0, WIDTH + COARSE_PX, COARSE_PX),
                         np.arange(0, HEIGHT + COARSE_PX, COARSE_PX))  # fmt: skip
    coarse = _inside_leg(c2w, np.column_stack([gu.ravel(), gv.ravel()]).astype(float))
    coarse = coarse.reshape(gu.shape)
    corners = np.stack([coarse[:-1, :-1], coarse[1:, :-1], coarse[:-1, 1:], coarse[1:, 1:]])
    mixed = ndimage.binary_dilation(corners.any(0) & ~corners.all(0), iterations=1)
    uu, vv = np.meshgrid(np.arange(WIDTH), np.arange(HEIGHT))
    ci, cj = vv // COARSE_PX, uu // COARSE_PX
    value = corners.all(0)[ci, cj]
    exact = mixed[ci, cj]
    value[exact] = _inside_leg(c2w, np.column_stack([uu[exact], vv[exact]]).astype(float))
    return np.where(value, 255, 0).astype(np.uint8)


def leg_points(n: int, rng: np.random.Generator) -> np.ndarray:
    h = rng.uniform(0.0, TOP_H, n)
    th = rng.uniform(0.0, 2 * np.pi, n)
    a, b, cx, cz = section(h)
    c, s = np.cos(ELLIPSE_ANGLE_RAD), np.sin(ELLIPSE_ANGLE_RAD)
    px, pz = a * np.cos(th), b * np.sin(th)
    return np.column_stack([cx + c * px - s * pz, h, cz + s * px + c * pz])


def floor_points(n: int, rng: np.random.Generator) -> np.ndarray:
    r = 0.9 * np.sqrt(rng.uniform(0.0, 1.0, n))
    th = rng.uniform(0.0, 2 * np.pi, n)
    return np.column_stack([r * np.cos(th), np.zeros(n), r * np.sin(th)])


@dataclass(frozen=True)
class Scene:
    c2w: tuple[np.ndarray, ...]  # truth world, silhouette convention, meters, +Y up
    masks: tuple[np.ndarray, ...]
    joints: tuple[dict[str, list[float]], ...]
    sharpness: tuple[float, ...]
    points: np.ndarray  # truth world


def _joints(c2w: np.ndarray) -> dict[str, list[float]]:
    from test_silhouette import ANKLE_H, KNEE_H

    out = {}
    for name, h in (("right_ankle", ANKLE_H), ("right_knee", KNEE_H)):
        _, _, cx, cz = section(np.array([h]))
        uv = project(c2w, INTRINSICS, np.array([[cx[0], h, cz[0]]]))[0][0]
        out[name] = [float(uv[0]), float(uv[1]), 0.9]
    # A confident left leg detection off the leg: the harness must pick the right side.
    out["left_knee"] = [5.0, 5.0, 0.9]
    out["left_ankle"] = [6.0, 300.0, 0.9]
    return out


@functools.lru_cache
def _masks(arc_deg: float, n_frames: int, upside_down: bool) -> tuple[np.ndarray, ...]:
    """The rendered masks of an arc (cached apart from the cloud: rendering dominates)."""
    return tuple(render_mask(c2w) for c2w in _arc(arc_deg, n_frames, upside_down))


def _arc(arc_deg: float, n_frames: int, upside_down: bool) -> list[np.ndarray]:
    target = np.array([0.0, TARGET_HEIGHT_M, 0.0])
    out = []
    for az in np.radians(np.linspace(-arc_deg / 2, arc_deg / 2, n_frames)):
        pos = np.array(
            [np.sin(az) * CAMERA_DISTANCE_M, CAMERA_HEIGHT_M, np.cos(az) * CAMERA_DISTANCE_M]
        )
        c2w = upright_camera(pos, target)
        out.append(c2w @ _ROLL_HALF_TURN if upside_down else c2w)
    return out


@functools.lru_cache
def scene(
    n_frames: int = 26, arc_deg: float = ARC_DEG, floor: bool = True, upside_down: bool = False
) -> Scene:
    """upside_down rolls every phone half a turn: the foot is at the top of the frame and
    the cameras' mean image-up points at the floor (IMG_3836, 2026-11-11)."""
    rng = np.random.default_rng(7)
    c2ws = _arc(arc_deg, n_frames, upside_down)
    joints = [_joints(c2w) for c2w in c2ws]
    sharp = [10.0 if i % 7 == 3 else float(100.0 + rng.uniform(-20, 20)) for i in range(n_frames)]
    parts = [leg_points(3000, rng)]
    if floor:
        parts.append(floor_points(3000, rng))
    parts.append(rng.uniform([-1.0, 0.1, -1.0], [1.0, 1.2, -0.6], (150, 3)))  # clutter behind
    pts = np.vstack(parts) + rng.normal(0.0, 0.001, (sum(len(p) for p in parts), 3))
    masks = _masks(arc_deg, n_frames, upside_down)
    return Scene(tuple(c2ws), masks, tuple(joints), tuple(sharp), pts)


# --- session frame and conventions ---------------------------------------------------------


@dataclass(frozen=True)
class Similarity:
    scale: float
    rotation: np.ndarray
    translation: np.ndarray

    def point(self, p: np.ndarray) -> np.ndarray:
        return self.scale * np.asarray(p) @ self.rotation.T + self.translation

    def c2w(self, m: np.ndarray) -> np.ndarray:
        out = np.eye(4)
        out[:3, :3] = self.rotation @ m[:3, :3]
        out[:3, 3] = self.point(m[:3, 3])
        return out

    @property
    def up(self) -> np.ndarray:
        return self.rotation @ np.array([0.0, 1.0, 0.0])


IDENTITY = Similarity(1.0, np.eye(3), np.zeros(3))


def random_similarity(seed: int) -> Similarity:
    rng = np.random.default_rng(seed)
    return Similarity(
        scale=float(np.exp(rng.uniform(np.log(0.2), np.log(5.0)))),
        rotation=Rotation.random(random_state=int(rng.integers(1 << 30))).as_matrix(),
        translation=rng.normal(0.0, 2.0, 3),
    )


def encode_pose(c2w_session: np.ndarray, convention: str) -> np.ndarray:
    """The Pose.transform forms-video would write if RealityKit used `convention`."""
    direction, axes = convention.split("_")
    m = c2w_session @ _FLIP if axes == "opencv" else c2w_session
    return m if direction == "c2w" else rigid_inverse(m)


def session_cameras(
    sc: Scene, sim: Similarity, convention: str, masks: bool = False
) -> list[Camera]:
    from forms_pipeline.harness.frame import MaskLookup

    return [
        Camera(
            frame_id=i,
            transform=encode_pose(sim.c2w(c2w), convention),
            intrinsics=INTRINSICS,
            width=WIDTH,
            height=HEIGHT,
            mask=MaskLookup.from_mask(sc.masks[i]) if masks else None,
        )
        for i, c2w in enumerate(sc.c2w)
    ]


# --- bundle writer -----------------------------------------------------------------------


def write_bundle(
    root: Path,
    sc: Scene,
    convention: str = "c2w_arkit",
    sim: Similarity = IDENTITY,
    intrinsics: bool = True,
    status: str = "ok",
    error: str | None = None,
    registered: set[int] | None = None,
    points: bool = True,
    foreground: bool = True,
) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for sub in ("frames", "masks/person", "masks/foreground"):
        (root / sub).mkdir(parents=True, exist_ok=True)
    jpeg = fake_jpeg(WIDTH, HEIGHT)
    fx, fy, cx, cy = INTRINSICS
    frames: list[dict[str, Any]] = []
    for i, (c2w, mask) in enumerate(zip(sc.c2w, sc.masks, strict=True)):
        (root / f"frames/{i:03d}.jpg").write_bytes(jpeg)
        png = encode_png(mask)
        (root / f"masks/person/{i:03d}.png").write_bytes(png)
        area = float((mask >= 128).mean())
        fg = None
        if foreground:
            (root / f"masks/foreground/{i:03d}.png").write_bytes(png)
            fg = {"file": f"masks/foreground/{i:03d}.png", "area_fraction": area, "instances": 1}
        has_pose = status == "ok" and (registered is None or i in registered)
        pose = None
        if has_pose:
            pose = {
                "transform": encode_pose(sim.c2w(c2w), convention).flatten(order="F").tolist(),
                "intrinsics": [fx, 0, 0, 0, fy, 0, cx, cy, 1] if intrinsics else None,
            }
        frames.append(
            {
                "id": i,
                "file": f"frames/{i:03d}.jpg",
                "time_s": 0.1 * i,
                "width": WIDTH,
                "height": HEIGHT,
                "sharpness": sc.sharpness[i],
                "motion_px": None if i == 0 else 3.0,
                "masks": {
                    "person": {"file": f"masks/person/{i:03d}.png", "area_fraction": area},
                    "foreground": fg,
                },
                "joints": sc.joints[i],
                "pose": pose,
            }
        )
    n_reg = sum(f["pose"] is not None for f in frames)
    pts = sim.point(sc.points).astype("<f4")
    if points and status == "ok":
        (root / "points.f32").write_bytes(pts.tobytes())
    manifest = {
        "format": "forms.video-bundle",
        "version": 1,
        "source": {
            "duration_s": 10.0,
            "fps": 30.0,
            "width": WIDTH,
            "height": HEIGHT,
            "frames_decoded": 300,
        },  # fmt: skip
        "tool": {"name": "forms-video", "seconds": 1.0, "max_frames": 60},
        "photogrammetry": {
            "status": status,
            "error": error,
            "submitted": len(frames),
            "registered": n_reg,
            "points": len(pts) if points and status == "ok" else 0,
            "model": False,
            "convention": "realitykit_pose",
        },
        "frames": frames,
    }
    (root / "video.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root


def edit_manifest(root: Path, edit) -> None:
    path = root / "video.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    edit(manifest)
    path.write_text(json.dumps(manifest), encoding="utf-8")
