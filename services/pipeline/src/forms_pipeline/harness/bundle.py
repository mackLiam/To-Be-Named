"""Parse and validate a forms.video-bundle v1 directory (docs/VIDEO-HARNESS.md).

The bundle is untrusted: manifest and file sizes are capped before reading, every
file name must match its pinned pattern exactly (so no name can point elsewhere),
and every resolved path must stay inside the bundle directory (so a symlink
cannot either). Masks are decoded on demand by load_mask so a 200-frame bundle
is never held in memory at once. Every failure is a HarnessBundleError.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from forms_pipeline.harness import HarnessBundleError
from forms_pipeline.reconstruct import BundleValidationError
from forms_pipeline.reconstruct.bundle import jpeg_dimensions
from forms_pipeline.reconstruct.png import decode_gray8, png_header

FORMAT = "forms.video-bundle"
VERSION = 1
MANIFEST = "video.json"
POINTS_FILE = "points.f32"
MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_FRAMES = 200
MAX_SIDE_PX = 4096
MAX_POINTS = 2_000_000
MAX_FRAME_ID = 999  # NNN is three digits
# Not contract caps: generous bounds so one corrupt file cannot exhaust memory.
MAX_JPEG_BYTES = 32 * 1024 * 1024
MAX_PNG_BYTES = 32 * 1024 * 1024
PNG_HEADER_BYTES = 64
ROTATION_TOLERANCE = 1e-3

STATUSES = frozenset({"ok", "failed", "skipped"})
ERROR_KINDS = frozenset({"no_poses", "session_init", "process", "timeout", "unsupported"})
MASK_KINDS = ("person", "foreground")
JOINT_NAMES = frozenset(
    {"left_knee", "right_knee", "left_ankle", "right_ankle", "left_hip", "right_hip"}
)


@dataclass(frozen=True)
class MaskRef:
    file: str
    area_fraction: float


@dataclass(frozen=True)
class Frame:
    id: int
    file: str
    time_s: float
    width: int
    height: int
    sharpness: float
    motion_px: float | None
    masks: dict[str, MaskRef | None]
    joints: dict[str, tuple[float, float, float]]
    transform: np.ndarray | None  # 4x4, convention unresolved (frame.resolve_convention)
    intrinsics: tuple[float, float, float, float] | None  # fx, fy, cx, cy in pixels


@dataclass(frozen=True)
class Photogrammetry:
    status: str
    error: str | None
    submitted: int
    registered: int
    points: int
    model: bool
    convention: str | None


@dataclass(frozen=True)
class VideoBundle:
    root: Path
    source: dict[str, float]
    photogrammetry: Photogrammetry
    frames: tuple[Frame, ...]
    has_points: bool

    @property
    def registered_frames(self) -> list[Frame]:
        return [f for f in self.frames if f.transform is not None]


def _fail(reason: str) -> HarnessBundleError:
    return HarnessBundleError(f"Invalid video bundle: {reason}.")


def _obj(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _fail(f"{name} must be an object")
    return value


def _num(value: Any, name: str, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        raise _fail(f"{name} must be a finite number")
    if minimum is not None and value < minimum:
        raise _fail(f"{name} is below {minimum}")
    return float(value)


def _int(value: Any, name: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise _fail(f"{name} must be an integer in {minimum}..{maximum}")
    return value


def _inside(root: Path, rel: str) -> Path:
    """rel (already pattern-checked) resolved, required to be a file inside root."""
    path = (root / rel).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise _fail(f"{rel} is missing or outside the bundle")
    return path


def _read_capped(path: Path, cap: int, rel: str) -> bytes:
    if path.stat().st_size > cap:
        raise _fail(f"{rel} is larger than {cap // (1024 * 1024)}MB")
    return path.read_bytes()


def _matrix(values: Any, n: int, name: str) -> np.ndarray:
    if not isinstance(values, list) or len(values) != n * n:
        raise _fail(f"{name} must be {n * n} numbers")
    return np.array([_num(v, name) for v in values]).reshape(n, n, order="F")


def _transform(values: Any) -> np.ndarray:
    m = _matrix(values, 4, "pose.transform")
    rot = m[:3, :3]
    if (
        not np.allclose(m[3], [0.0, 0.0, 0.0, 1.0], atol=ROTATION_TOLERANCE)
        or not np.allclose(rot.T @ rot, np.eye(3), atol=ROTATION_TOLERANCE)
        or np.linalg.det(rot) <= 0
    ):
        raise _fail("pose.transform is not a rigid transform")
    return m


def _intrinsics(values: Any) -> tuple[float, float, float, float] | None:
    if values is None:
        return None
    k = _matrix(values, 3, "pose.intrinsics")
    fx, fy, cx, cy = float(k[0, 0]), float(k[1, 1]), float(k[0, 2]), float(k[1, 2])
    if fx <= 0 or fy <= 0:
        raise _fail("pose.intrinsics focal lengths must be positive")
    return fx, fy, cx, cy


def _joints(value: Any) -> dict[str, tuple[float, float, float]]:
    if value is None:
        return {}
    joints = {}
    for name, triple in _obj(value, "joints").items():
        if name not in JOINT_NAMES:
            raise _fail("joints has an unknown name")
        if not isinstance(triple, list) or len(triple) != 3:
            raise _fail("a joint must be [u, v, confidence]")
        u, v, c = (_num(x, "a joint") for x in triple)
        joints[name] = (u, v, c)
    return joints


def _mask_ref(
    root: Path, value: Any, kind: str, frame_id: int, size: tuple[int, int]
) -> MaskRef | None:
    if value is None:
        return None
    value = _obj(value, f"masks.{kind}")
    expected = f"masks/{kind}/{frame_id:03d}.png"
    if value.get("file") != expected:
        raise _fail(f"masks.{kind}.file must be {expected}")
    path = _inside(root, expected)
    if path.stat().st_size > MAX_PNG_BYTES:
        raise _fail(f"{expected} is larger than {MAX_PNG_BYTES // (1024 * 1024)}MB")
    with path.open("rb") as fh:
        head = fh.read(PNG_HEADER_BYTES)
    try:
        header = png_header(head)
    except (ValueError, StopIteration) as exc:
        raise _fail(f"{expected} is not a PNG") from exc
    if (header.width, header.height) != size:
        raise _fail(f"{expected} is not the frame's size")
    area = _num(value.get("area_fraction"), f"masks.{kind}.area_fraction", 0.0)
    return MaskRef(file=expected, area_fraction=area)


def _frame(root: Path, raw: Any, failed: bool) -> Frame:
    raw = _obj(raw, "a frame")
    frame_id = _int(raw.get("id"), "frame.id", 0, MAX_FRAME_ID)
    width = _int(raw.get("width"), "frame.width", 1, MAX_SIDE_PX)
    height = _int(raw.get("height"), "frame.height", 1, MAX_SIDE_PX)
    expected = f"frames/{frame_id:03d}.jpg"
    if raw.get("file") != expected:
        raise _fail(f"frame.file must be {expected}")
    data = _read_capped(_inside(root, expected), MAX_JPEG_BYTES, expected)
    try:
        dims = jpeg_dimensions(data)
    except BundleValidationError as exc:
        raise _fail(f"{expected} is not a readable JPEG") from exc
    if dims != (width, height):
        raise _fail(f"{expected} does not match its manifest size")

    masks_raw = _obj(raw.get("masks") or {}, "frame.masks")
    masks = {
        kind: _mask_ref(root, masks_raw.get(kind), kind, frame_id, (width, height))
        for kind in MASK_KINDS
    }
    pose_raw = raw.get("pose")
    transform, intrinsics = None, None
    if pose_raw is not None:
        if failed:
            raise _fail("a pose is present although photogrammetry did not succeed")
        pose = _obj(pose_raw, "frame.pose")
        transform = _transform(pose.get("transform"))
        intrinsics = _intrinsics(pose.get("intrinsics"))
    motion = raw.get("motion_px")
    return Frame(
        id=frame_id,
        file=expected,
        time_s=_num(raw.get("time_s"), "frame.time_s", 0.0),
        width=width,
        height=height,
        sharpness=_num(raw.get("sharpness"), "frame.sharpness", 0.0),
        motion_px=None if motion is None else _num(motion, "frame.motion_px", 0.0),
        masks=masks,
        joints=_joints(raw.get("joints")),
        transform=transform,
        intrinsics=intrinsics,
    )


def _photogrammetry(raw: Any) -> Photogrammetry:
    raw = _obj(raw, "photogrammetry")
    status = raw.get("status")
    if status not in STATUSES:
        raise _fail("photogrammetry.status is unknown")
    error = raw.get("error")
    if status == "failed":
        if error not in ERROR_KINDS:
            raise _fail("photogrammetry.error is not a known kind")
    elif error is not None:
        raise _fail("photogrammetry.error must be null unless status is failed")
    convention = raw.get("convention")
    if convention is not None and not (isinstance(convention, str) and len(convention) <= 64):
        raise _fail("photogrammetry.convention must be a short string")
    return Photogrammetry(
        status=status,
        error=error,
        submitted=_int(raw.get("submitted", 0), "photogrammetry.submitted", 0, MAX_FRAMES),
        registered=_int(raw.get("registered", 0), "photogrammetry.registered", 0, MAX_FRAMES),
        points=_int(raw.get("points", 0), "photogrammetry.points", 0, MAX_POINTS),
        model=bool(raw.get("model", False)),
        convention=convention,
    )


def load_bundle(directory: str | Path) -> VideoBundle:
    """Validate video.json and every file it names. Raises HarnessBundleError."""
    root = Path(directory).resolve()
    manifest = root / MANIFEST
    if not manifest.is_file():
        raise _fail(f"{MANIFEST} is missing")
    data = _read_capped(manifest, MAX_MANIFEST_BYTES, MANIFEST)
    try:
        raw = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise _fail(f"{MANIFEST} is not UTF-8 JSON") from exc
    raw = _obj(raw, MANIFEST)
    if raw.get("format") != FORMAT or raw.get("version") != VERSION:
        raise _fail(f"not {FORMAT} version {VERSION}")
    source_raw = _obj(raw.get("source"), "source")
    source = {
        key: _num(source_raw.get(key), f"source.{key}", 0.0)
        for key in ("duration_s", "fps", "width", "height", "frames_decoded")
    }
    photogrammetry = _photogrammetry(raw.get("photogrammetry"))
    frames_raw = raw.get("frames")
    if not isinstance(frames_raw, list):
        raise _fail("frames must be a list")
    if len(frames_raw) > MAX_FRAMES:
        raise _fail(f"more than {MAX_FRAMES} frames")
    failed = photogrammetry.status != "ok"
    frames = tuple(_frame(root, f, failed) for f in frames_raw)
    if len({f.id for f in frames}) != len(frames):
        raise _fail("frame ids are not unique")

    points = root / POINTS_FILE
    has_points = points.exists() or points.is_symlink()
    if has_points:
        path = _inside(root, POINTS_FILE)
        size = path.stat().st_size
        if size % 12:
            raise _fail(f"{POINTS_FILE} is not whole x,y,z float32 triples")
        if size // 12 > MAX_POINTS:
            raise _fail(f"{POINTS_FILE} has more than {MAX_POINTS} points")
    return VideoBundle(
        root=root,
        source=source,
        photogrammetry=photogrammetry,
        frames=frames,
        has_points=has_points,
    )


def load_points(bundle: VideoBundle) -> np.ndarray | None:
    """(N, 3) float64 finite points in session units, or None when absent."""
    if not bundle.has_points:
        return None
    path = _inside(bundle.root, POINTS_FILE)
    size = path.stat().st_size
    if size % 12 or size // 12 > MAX_POINTS:
        raise _fail(f"{POINTS_FILE} changed size")
    pts = np.fromfile(path, dtype="<f4").reshape(-1, 3).astype(np.float64)
    return pts[np.isfinite(pts).all(axis=1)]


def load_mask(bundle: VideoBundle, frame: Frame, kind: str) -> np.ndarray | None:
    """(height, width) uint8 mask of the given kind, or None when that request failed."""
    ref = frame.masks.get(kind)
    if ref is None:
        return None
    data = _read_capped(_inside(bundle.root, ref.file), MAX_PNG_BYTES, ref.file)
    try:
        mask = decode_gray8(data)
    except (ValueError, StopIteration) as exc:
        raise _fail(f"{ref.file} is not an 8-bit grayscale PNG") from exc
    if mask.shape != (frame.height, frame.width):
        raise _fail(f"{ref.file} is not the frame's size")
    return mask
