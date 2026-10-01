"""Parse and validate an uploaded photo-capture bundle (capture.json + NNN.jpg).

The client is untrusted: every cap in the capture contract is enforced here,
server-side, whatever the app claims to have checked. JPEG dimensions are read
from the file's own SOF header, never from capture.json.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any

import numpy as np

from forms_pipeline.reconstruct import BundleValidationError

FORMAT = "forms.photo-capture"
VERSION = 1
MIN_IMAGES = 20
MAX_IMAGES = 120
MAX_CAPTURE_JSON_BYTES = 1024 * 1024
MAX_JPEG_BYTES = 2 * 1024 * 1024
MAX_IMAGE_SIDE_PX = 2048
FILE_NAME_RE = re.compile(r"^\d{3}\.jpg$")
CAPTURE_MODES = frozenset({"solo", "helper"})
_CAPTURE_KEYS = frozenset(
    {"mode", "anchor_world", "front_azimuth_rad", "coverage", "finished_early"}
)

_RESCAN = "Please rescan."


@dataclass(frozen=True)
class CaptureImage:
    file: str
    camera_to_world: np.ndarray  # 4x4, meters, ARKit world (gravity -Y)
    intrinsics: tuple[float, float, float, float]
    width: int
    height: int
    tracking: str


@dataclass(frozen=True)
class CaptureInfo:
    """Capture v2 metadata. anchor_world is ARKit world meters, same frame as camera_to_world."""

    mode: str
    anchor_world: tuple[float, float, float]
    front_azimuth_rad: float
    coverage: float  # client-reported, untrusted, recorded only
    finished_early: bool


@dataclass(frozen=True)
class CaptureBundle:
    images: tuple[CaptureImage, ...]
    capture: CaptureInfo | None = None  # None: legacy (pre-v2) capture

    def camera_to_world_by_file(self) -> dict[str, np.ndarray]:
        return {img.file: img.camera_to_world for img in self.images}


def _fail(reason: str) -> BundleValidationError:
    return BundleValidationError(f"Photo capture upload is invalid: {reason}. {_RESCAN}")


def _is_number(v: Any) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool) and math.isfinite(v)


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def matrix_from_column_major(values: list[float]) -> np.ndarray:
    """16 column-major numbers -> 4x4 matrix (ARKit and RealityKit both use this order)."""
    return np.asarray(values, dtype=np.float64).reshape(4, 4).T


def _parse_image(i: int, raw: Any) -> CaptureImage:
    if not isinstance(raw, dict):
        raise _fail(f"image entry {i} is not an object")
    name = raw.get("file")
    if not isinstance(name, str) or not FILE_NAME_RE.fullmatch(name):
        raise _fail(f"image entry {i} has an invalid file name")
    if not _is_number(raw.get("timestamp")):
        raise _fail(f"{name} has an invalid timestamp")

    c2w = raw.get("camera_to_world")
    if not isinstance(c2w, list) or len(c2w) != 16 or not all(_is_number(v) for v in c2w):
        raise _fail(f"{name} has an invalid camera_to_world")
    matrix = matrix_from_column_major(c2w)
    if not np.allclose(matrix[3], [0.0, 0.0, 0.0, 1.0], atol=1e-4):
        raise _fail(f"{name} camera_to_world is not a rigid transform")

    intr = raw.get("intrinsics")
    if not isinstance(intr, list) or len(intr) != 4 or not all(_is_number(v) for v in intr):
        raise _fail(f"{name} has invalid intrinsics")
    if intr[0] <= 0 or intr[1] <= 0:
        raise _fail(f"{name} has invalid intrinsics")

    width, height = raw.get("width"), raw.get("height")
    if not (_is_int(width) and _is_int(height)) or width <= 0 or height <= 0:
        raise _fail(f"{name} has invalid dimensions")
    if max(width, height) > MAX_IMAGE_SIDE_PX:
        raise _fail(f"{name} is larger than {MAX_IMAGE_SIDE_PX}px")

    tracking = raw.get("tracking")
    if not isinstance(tracking, str) or len(tracking) > 32:
        raise _fail(f"{name} has an invalid tracking state")

    return CaptureImage(
        file=name,
        camera_to_world=matrix,
        intrinsics=(float(intr[0]), float(intr[1]), float(intr[2]), float(intr[3])),
        width=width,
        height=height,
        tracking=tracking,
    )


def _parse_capture_info(raw: Any) -> CaptureInfo:
    if not isinstance(raw, dict):
        raise _fail("capture info is not an object")
    if set(raw) != _CAPTURE_KEYS:
        raise _fail("capture info has missing or unknown fields")
    mode = raw["mode"]
    if not isinstance(mode, str) or mode not in CAPTURE_MODES:
        raise _fail("capture info has an invalid mode")
    anchor = raw["anchor_world"]
    if not isinstance(anchor, list) or len(anchor) != 3 or not all(_is_number(v) for v in anchor):
        raise _fail("capture info has an invalid anchor")
    if not _is_number(raw["front_azimuth_rad"]):
        raise _fail("capture info has an invalid front azimuth")
    coverage = raw["coverage"]
    if not _is_number(coverage) or not 0.0 <= coverage <= 1.0:
        raise _fail("capture info has an invalid coverage")
    if not isinstance(raw["finished_early"], bool):
        raise _fail("capture info has an invalid finished_early")
    return CaptureInfo(
        mode=mode,
        anchor_world=(float(anchor[0]), float(anchor[1]), float(anchor[2])),
        front_azimuth_rad=float(raw["front_azimuth_rad"]),
        coverage=float(coverage),
        finished_early=raw["finished_early"],
    )


def parse_capture(data: bytes) -> CaptureBundle:
    """Validate capture.json bytes against the forms.photo-capture v1 contract."""
    if len(data) > MAX_CAPTURE_JSON_BYTES:
        raise _fail("capture.json is too large")
    try:
        doc = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise _fail("capture.json is not valid JSON") from exc
    if not isinstance(doc, dict):
        raise _fail("capture.json is not an object")
    if doc.get("format") != FORMAT:
        raise _fail("unknown capture format")
    version = doc.get("version")
    if not _is_int(version) or version != VERSION:
        raise _fail("unsupported capture version")
    device = doc.get("device")
    if not isinstance(device, dict) or not all(
        isinstance(device.get(k), str) for k in ("model", "os")
    ):
        raise _fail("missing device info")

    raw_images = doc.get("images")
    if not isinstance(raw_images, list):
        raise _fail("missing image list")
    if not MIN_IMAGES <= len(raw_images) <= MAX_IMAGES:
        raise _fail(f"expected {MIN_IMAGES} to {MAX_IMAGES} photos, got {len(raw_images)}")

    images = tuple(_parse_image(i, raw) for i, raw in enumerate(raw_images))
    if len({img.file for img in images}) != len(images):
        raise _fail("duplicate image file names")
    capture = _parse_capture_info(doc["capture"]) if "capture" in doc else None
    return CaptureBundle(images=images, capture=capture)


# SOF0..SOF15 carry frame dimensions; C4 (DHT), C8 (JPG ext) and CC (DAC) do not.
_SOF_MARKERS = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
# Markers with no length field.
_STANDALONE_MARKERS = frozenset({0x01, *range(0xD0, 0xD8)})


def jpeg_dimensions(data: bytes) -> tuple[int, int]:
    """(width, height) from the first SOF segment. Raises BundleValidationError."""
    if data[:2] != b"\xff\xd8":
        raise _fail("a photo is not a JPEG")
    pos, n = 2, len(data)
    while pos < n:
        if data[pos] != 0xFF:
            raise _fail("a photo is a corrupt JPEG")
        while pos < n and data[pos] == 0xFF:  # fill bytes
            pos += 1
        if pos >= n:
            break
        marker = data[pos]
        pos += 1
        if marker in _STANDALONE_MARKERS:
            continue
        if marker in (0xD9, 0xDA):  # EOI or SOS before any frame header
            break
        if pos + 2 > n:
            break
        length = int.from_bytes(data[pos : pos + 2], "big")
        if length < 2 or pos + length > n:
            break
        if marker in _SOF_MARKERS:
            if length < 7:
                break
            height = int.from_bytes(data[pos + 3 : pos + 5], "big")
            width = int.from_bytes(data[pos + 5 : pos + 7], "big")
            if width == 0 or height == 0:
                break
            return width, height
        pos += length
    raise _fail("a photo is a corrupt JPEG")


def validate_jpeg(image: CaptureImage, data: bytes) -> None:
    """Byte cap, real JPEG header, real dimensions within cap and matching capture.json."""
    if len(data) > MAX_JPEG_BYTES:
        raise _fail(f"{image.file} is larger than {MAX_JPEG_BYTES // (1024 * 1024)}MB")
    width, height = jpeg_dimensions(data)
    if max(width, height) > MAX_IMAGE_SIDE_PX:
        raise _fail(f"{image.file} is larger than {MAX_IMAGE_SIDE_PX}px")
    if (width, height) != (image.width, image.height):
        raise _fail(f"{image.file} dimensions do not match capture.json")
