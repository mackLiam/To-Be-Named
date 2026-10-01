"""Pure logic for forms-replay: no network, no clock, no environment."""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from forms_pipeline.reconstruct.bundle import MAX_CAPTURE_JSON_BYTES, MAX_IMAGES

IMAGE_NAME_RE = re.compile(r"^\d{3}\.jpg$")
MASK_NAME_RE = re.compile(r"^\d{3}\.png$")
LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost"})
RECORDING_FILE = "recording.json"
CAPTURE_FILE = "capture.json"
MESH_FILE = "mesh.obj"
CAPTURE_KINDS = frozenset({"photos", "mesh"})
LEGS = frozenset({"L", "R"})
TEST_EMAIL_DOMAIN = "forms.test"


class ReplayError(RuntimeError):
    """A user-facing failure. Messages must never carry tokens, keys, or scan bytes."""


def require_local(url: str) -> str:
    """Return url if its host is loopback. Every write path calls this first, so a
    hosted project (real users' body scans) can never be touched."""
    host = urlparse(url).hostname
    if host not in LOCAL_HOSTS:
        raise ReplayError(f"refusing non-local Supabase URL host {host!r}; local stack only")
    return url.rstrip("/")


def require_uuid(value: object, what: str) -> str:
    """Canonical uuid text. Ids are spliced into storage paths, so anything else is refused."""
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        raise ReplayError(f"{what} is not a uuid") from None


def manifest_images(capture_json: bytes) -> list[str]:
    """Image file names listed by a capture.json, validated as ^\\d{3}\\.jpg$, unique, capped."""
    if len(capture_json) > MAX_CAPTURE_JSON_BYTES:
        raise ReplayError("capture.json is too large")
    try:
        manifest = json.loads(capture_json)
    except ValueError:
        raise ReplayError("capture.json is not valid JSON") from None
    images = manifest.get("images") if isinstance(manifest, dict) else None
    if not isinstance(images, list) or not images:
        raise ReplayError("capture.json has no images list")
    if len(images) > MAX_IMAGES:
        raise ReplayError(f"capture.json lists more than {MAX_IMAGES} images")
    names: list[str] = []
    for i, entry in enumerate(images):
        name = entry.get("file") if isinstance(entry, dict) else None
        if not isinstance(name, str) or not IMAGE_NAME_RE.fullmatch(name):
            raise ReplayError(f"capture.json image {i} has an invalid file name")
        if name in names:
            raise ReplayError(f"capture.json lists {name} twice")
        names.append(name)
    return names


def manifest_masks(capture_json: bytes) -> list[str]:
    """Silhouette (v2) mask names, ^\\d{3}\\.png$ with the photo's stem; empty for v1."""
    manifest = json.loads(capture_json)
    masks: list[str] = []
    for i, entry in enumerate(manifest.get("images") or []):
        if not isinstance(entry, dict) or "mask" not in entry:
            continue
        name = entry["mask"]
        if not isinstance(name, str) or not MASK_NAME_RE.fullmatch(name):
            raise ReplayError(f"capture.json image {i} has an invalid mask name")
        if name[:3] != str(entry.get("file", ""))[:3]:
            raise ReplayError(f"capture.json image {i} mask does not match its photo")
        masks.append(name)
    return masks


@dataclass(frozen=True)
class Bundle:
    root: Path
    meta: dict[str, Any]
    capture_kind: str
    leg: str
    images: tuple[str, ...]  # empty for a mesh recording
    masks: tuple[str, ...] = ()  # silhouette (v2) recordings only

    @property
    def expected(self) -> dict[str, float] | None:
        m = self.meta.get("measurements")
        return m.get("values") if isinstance(m, dict) else None


def load_bundle(root: Path) -> Bundle:
    """Read and check a recording directory; every file replay will upload must exist."""
    meta_path = root / RECORDING_FILE
    if not meta_path.is_file():
        raise ReplayError(f"{root} has no {RECORDING_FILE}")
    meta = json.loads(meta_path.read_text())
    kind, leg = meta.get("capture_kind"), meta.get("leg")
    if kind not in CAPTURE_KINDS:
        raise ReplayError(f"recording has unknown capture_kind {kind!r}")
    if leg not in LEGS:
        raise ReplayError(f"recording has invalid leg {leg!r}")
    images: list[str] = []
    masks: list[str] = []
    if kind == "photos":
        capture = root / CAPTURE_FILE
        if not capture.is_file():
            raise ReplayError(f"photo recording is missing {CAPTURE_FILE}")
        images = manifest_images(capture.read_bytes())
        masks = manifest_masks(capture.read_bytes())
        missing = [n for n in images if not (root / "images" / n).is_file()]
        missing += [n for n in masks if not (root / "masks" / n).is_file()]
        if missing:
            raise ReplayError(f"recording is missing {len(missing)} image(s), e.g. {missing[0]}")
    elif not (root / MESH_FILE).is_file():
        raise ReplayError(f"mesh recording is missing {MESH_FILE}")
    return Bundle(
        root=root, meta=meta, capture_kind=kind, leg=leg, images=tuple(images), masks=tuple(masks)
    )


def recording_summary(root: Path) -> tuple[int, int]:
    """(total bytes, image count) of one recording directory."""
    size = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
    images_dir = root / "images"
    count = (
        sum(1 for p in images_dir.iterdir() if IMAGE_NAME_RE.fullmatch(p.name))
        if images_dir.is_dir()
        else 0
    )
    return size, count


def replay_user_email(seed: str) -> str:
    """Stable per-recording local test user, so replays reuse one account."""
    digest = hashlib.sha256(seed.encode()).hexdigest()[:12]
    return f"replay+{digest}@{TEST_EMAIL_DOMAIN}"


def find_user_id(users: list[dict[str, Any]], email: str) -> str | None:
    for user in users:
        if str(user.get("email", "")).lower() == email.lower():
            return str(user["id"])
    return None


# Job states, from the queue helpers (0001 fail_pipeline_job, 0008 complete_pipeline_job).
RUNNING, SUCCEEDED, FAILED = "running", "succeeded", "failed"


def job_outcome(job: dict[str, Any]) -> str:
    """RUNNING while the worker may still act on the job, else SUCCEEDED or FAILED.
    A 'pending' job with an error is a scheduled retry, so it is still RUNNING."""
    status = job.get("status")
    if status == "succeeded":
        return SUCCEEDED
    if status == "dead_letter":
        return FAILED
    if status == "failed" and int(job.get("attempts") or 0) >= int(job.get("max_attempts") or 0):
        return FAILED
    return RUNNING


def job_signature(job: dict[str, Any]) -> tuple[Any, ...]:
    """What counts as a transition worth printing."""
    return (job.get("step"), job.get("status"), job.get("attempts"))


def printable_artifacts(artifacts: dict[str, Any] | None) -> dict[str, Any]:
    """Scalar artifacts only: nested values could hold poses or paths, which never print."""
    return {
        k: v
        for k, v in (artifacts or {}).items()
        if v is None or isinstance(v, str | int | float | bool)
    }


@dataclass(frozen=True)
class DiffRow:
    key: str
    expected: float | None
    actual: float | None

    @property
    def delta_mm(self) -> float | None:
        if self.expected is None or self.actual is None:
            return None
        return self.actual - self.expected

    @property
    def delta_pct(self) -> float | None:
        d = self.delta_mm
        if d is None or not self.expected:
            return None
        return 100.0 * d / self.expected


def diff_measurements(
    expected: dict[str, float], actual: dict[str, float], keys: tuple[str, ...]
) -> list[DiffRow]:
    """One row per schema key, in schema order; a key absent on either side keeps None."""
    return [DiffRow(k, expected.get(k), actual.get(k)) for k in keys]


def format_diff(rows: list[DiffRow]) -> str:
    def num(v: float | None, fmt: str) -> str:
        return "-" if v is None else format(v, fmt)

    width = max([len(r.key) for r in rows] + [3])
    lines = [f"{'key':<{width}}  {'recorded':>9}  {'replay':>9}  {'d mm':>8}  {'d %':>7}"]
    for r in rows:
        lines.append(
            f"{r.key:<{width}}  {num(r.expected, '9.2f')}  {num(r.actual, '9.2f')}  "
            f"{num(r.delta_mm, '+8.2f')}  {num(r.delta_pct, '+7.2f')}"
        )
    return "\n".join(lines)
