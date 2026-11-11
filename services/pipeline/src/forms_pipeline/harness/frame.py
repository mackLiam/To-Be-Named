"""Photogrammetry session frame -> an ARKit-like world for the silhouette math. Pure numpy.

PhotogrammetrySession poses have arbitrary scale, orientation and an unrecorded
convention, and plain video has no gravity. Here:
1. resolve_convention picks how to read Pose.transform: camera_to_world or
   world_to_camera, times camera axes "-Z forward, +Y up" (arkit) or "+Z forward,
   +Y down" (opencv). Every candidate becomes a silhouette-convention
   camera_to_world (silhouette.py module docstring) and is scored by the share of
   point-cloud points it projects in front of the camera and inside the frame.
   That score alone is not decisive: read the wrong way round, a compact cloud far
   from the session origin collapses to one spot that many cameras "see". So every
   candidate within CONVENTION_TIE_FRACTION of the best is a near-tie, decided by
   mask coverage: the share of leg-mask cells that projected points land in.
2. fit_floor: RANSAC plane fit (seeded) on the point cloud; the floor is the
   largest plane with every camera on one side whose normal lies near the cameras'
   mean image-up axis, of either sign (a phone held upside down films the foot at
   the top of the frame), and up is its normal toward the cameras, which are always
   above the floor. RANSAC sees only points outside the leg masks (floor_candidates).
   Without a floor, up comes from the leg itself (leg_axis_up).
3. build_world: +Y up, origin at the leg position, uniform scale so the median
   camera-to-leg distance is NOMINAL_CAMERA_DISTANCE_M. Scale is nominal, never real.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace

import numpy as np

from forms_pipeline.reconstruct import ReconstructionQualityError
from forms_pipeline.reconstruct.silhouette import (
    MIN_VIEWS,
    View,
    centerline_normal,
    leg_component,
    project,
    triangulate_axis,
)

CONVENTIONS = ("c2w_arkit", "c2w_opencv", "w2c_arkit", "w2c_opencv")
_OPENCV_TO_ARKIT = np.diag([1.0, -1.0, -1.0, 1.0])

UP_FLOOR = "floor_plane"
UP_LEG_AXIS = "leg_axis"
UP_CAMERA_MEAN = "camera_mean"
INTRINSICS_POSE = "pose"
INTRINSICS_ASSUMED = "assumed"
LEG_FROM_MASKS = "mask_points"
LEG_FROM_CLOUD = "cloud_median"

# About a 26 mm equivalent iPhone main camera: fx = fy = this x the long side.
ASSUMED_FOCAL_FRACTION = 0.69
NOMINAL_CAMERA_DISTANCE_M = 0.40
MAX_SCORING_POINTS = 20_000
MASK_LOOKUP_MAX_SIDE = 320
# Candidates scoring at least this fraction of the best in-view score are near-tied.
CONVENTION_TIE_FRACTION = 0.5
COVERAGE_CELLS = 32  # mask coverage grid, cells along the long side
MIN_IN_VIEW_SCORE = 0.05
# RANSAC, in units of the scene scale (median camera distance to the cloud median).
FLOOR_ITERATIONS = 400
FLOOR_TOLERANCE_FRACTION = 0.01
MIN_FLOOR_INLIER_FRACTION = 0.10
MIN_FLOOR_INLIERS = 30
# A plane steeper than this from the cameras' mean image-up axis (either sign) is a
# wall, not the floor.
# TODO(liam): 50 is a guess; a steeply pitched or rolled phone could exceed it.
MAX_FLOOR_TILT_DEG = 50.0
MIN_LEG_POINTS = 20
SEED = 0
# Foot-end vote (leg_axis_up): mask widths across the projected axis in this many
# bands, read over this share of the mask's length (clear of a pointed toe or a
# rounded mask end), needing this many bands clear of the image border.
FOOT_BANDS = 24
FOOT_RANGE = (0.1, 0.9)
MIN_FOOT_BANDS = 8


class FrameError(RuntimeError):
    """The session frame cannot be turned into a usable world. Message is the reason."""


@dataclass(frozen=True)
class MaskLookup:
    """Coarse membership test for a mask, sampled every `stride` pixels."""

    grid: np.ndarray  # bool
    stride: int

    @classmethod
    def from_mask(cls, mask: np.ndarray, max_side: int = MASK_LOOKUP_MAX_SIDE) -> MaskLookup:
        stride = max(1, int(np.ceil(max(mask.shape) / max_side)))
        return cls(grid=mask[::stride, ::stride] >= 128, stride=stride)

    def contains(self, uv: np.ndarray) -> np.ndarray:
        with np.errstate(invalid="ignore"):
            cols = np.floor(uv[:, 0] / self.stride + 0.5)
            rows = np.floor(uv[:, 1] / self.stride + 0.5)
        h, w = self.grid.shape
        ok = np.isfinite(cols) & np.isfinite(rows) & (cols >= 0) & (cols < w)
        ok &= (rows >= 0) & (rows < h)
        out = np.zeros(len(uv), dtype=bool)
        out[ok] = self.grid[rows[ok].astype(np.int64), cols[ok].astype(np.int64)]
        return out

    def coverage(self, uv: np.ndarray) -> float:
        """Share of the mask's COVERAGE_CELLS-grid cells that hold at least one of uv."""
        k = max(1, int(np.ceil(max(self.grid.shape) / COVERAGE_CELLS)))
        h, w = -(-self.grid.shape[0] // k), -(-self.grid.shape[1] // k)
        rows, cols = np.nonzero(self.grid)
        cells = np.zeros((h, w), dtype=bool)
        cells[rows // k, cols // k] = True
        if not cells.any():
            return 0.0
        with np.errstate(invalid="ignore"):
            c = np.floor(uv[:, 0] / self.stride + 0.5) // k
            r = np.floor(uv[:, 1] / self.stride + 0.5) // k
        ok = np.isfinite(c) & np.isfinite(r) & (c >= 0) & (c < w) & (r >= 0) & (r < h)
        hits = np.zeros_like(cells)
        hits[r[ok].astype(np.int64), c[ok].astype(np.int64)] = True
        return float((hits & cells).sum() / cells.sum())


@dataclass(frozen=True)
class Camera:
    """One registered frame in session units, convention not yet resolved."""

    frame_id: int
    transform: np.ndarray  # 4x4 as written by forms-video
    intrinsics: tuple[float, float, float, float]
    width: int
    height: int
    mask: MaskLookup | None = None  # the chosen leg mask kind (person or foreground)


@dataclass(frozen=True)
class ConventionChoice:
    name: str
    in_view: float
    coverage: float
    scores: dict[str, dict[str, float]]


@dataclass(frozen=True)
class FloorPlane:
    normal: np.ndarray  # unit, toward the cameras
    offset: float  # plane: normal . x = offset (session units)
    inliers: int
    inlier_fraction: float


@dataclass(frozen=True)
class WorldFrame:
    rotation: np.ndarray  # session -> world, world +Y = up
    origin: np.ndarray  # session point that becomes the world origin (the leg)
    scale: float  # nominal meters per session unit
    floor_y: float | None

    def point(self, p: np.ndarray) -> np.ndarray:
        return self.scale * (np.asarray(p) - self.origin) @ self.rotation.T

    def camera_to_world(self, c2w_session: np.ndarray) -> np.ndarray:
        out = np.eye(4)
        out[:3, :3] = self.rotation @ c2w_session[:3, :3]
        out[:3, 3] = self.point(c2w_session[:3, 3])
        return out


def rigid_inverse(m: np.ndarray) -> np.ndarray:
    out = np.eye(4)
    out[:3, :3] = m[:3, :3].T
    out[:3, 3] = -m[:3, :3].T @ m[:3, 3]
    return out


def to_camera_to_world(transform: np.ndarray, convention: str) -> np.ndarray:
    """Pose.transform read under `convention` -> silhouette-convention camera_to_world."""
    direction, axes = convention.split("_")
    if direction not in ("c2w", "w2c") or axes not in ("arkit", "opencv"):
        raise ValueError(f"unknown convention {convention}")
    c2w = transform if direction == "c2w" else rigid_inverse(transform)
    return c2w @ _OPENCV_TO_ARKIT if axes == "opencv" else c2w.copy()


def assumed_intrinsics(width: int, height: int) -> tuple[float, float, float, float]:
    f = ASSUMED_FOCAL_FRACTION * max(width, height)
    return f, f, (width - 1) / 2.0, (height - 1) / 2.0


def frame_intrinsics(
    intrinsics: tuple[float, float, float, float] | None, width: int, height: int
) -> tuple[tuple[float, float, float, float], str]:
    """The pose's intrinsics when given and its principal point is near the center."""
    if intrinsics is not None:
        _, _, cx, cy = intrinsics
        # Off-center by more than this, the intrinsics belong to another image size or
        # orientation (a landscape sensor frame) than the written portrait JPEG.
        if abs(cx - width / 2) <= 0.25 * width and abs(cy - height / 2) <= 0.25 * height:
            return intrinsics, INTRINSICS_POSE
    return assumed_intrinsics(width, height), INTRINSICS_ASSUMED


def subsample(points: np.ndarray, limit: int = MAX_SCORING_POINTS) -> np.ndarray:
    if len(points) <= limit:
        return points
    idx = np.random.default_rng(SEED).choice(len(points), limit, replace=False)
    return points[np.sort(idx)]


def _in_frame(uv: np.ndarray, depth: np.ndarray, width: int, height: int) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        return (
            (depth > 0)
            & (uv[:, 0] >= 0)
            & (uv[:, 0] <= width - 1)
            & (uv[:, 1] >= 0)
            & (uv[:, 1] <= height - 1)
        )


def resolve_convention(cameras: Sequence[Camera], points: np.ndarray) -> ConventionChoice:
    """Pick the Pose.transform reading that best explains the point cloud."""
    pts = subsample(points)
    scores: dict[str, dict[str, float]] = {}
    for name in CONVENTIONS:
        in_view, coverage = [], []
        for cam in cameras:
            uv, depth = project(to_camera_to_world(cam.transform, name), cam.intrinsics, pts)
            seen = _in_frame(uv, depth, cam.width, cam.height)
            in_view.append(seen.mean() if len(pts) else 0.0)
            if cam.mask is not None:
                coverage.append(cam.mask.coverage(uv[seen]))
        scores[name] = {
            "in_view": float(np.mean(in_view)) if in_view else 0.0,
            "coverage": float(np.mean(coverage)) if coverage else 0.0,
        }
    best_in_view = max(s["in_view"] for s in scores.values())
    if best_in_view < MIN_IN_VIEW_SCORE:
        raise FrameError("No pose convention puts the point cloud in front of the cameras.")
    tied = [
        n for n in CONVENTIONS if scores[n]["in_view"] >= CONVENTION_TIE_FRACTION * best_in_view
    ]
    name = max(tied, key=lambda n: (scores[n]["coverage"], scores[n]["in_view"]))
    return ConventionChoice(
        name=name,
        in_view=scores[name]["in_view"],
        coverage=scores[name]["coverage"],
        scores=scores,
    )


def camera_mean_up(c2ws: Sequence[np.ndarray]) -> np.ndarray:
    """Mean image-up (camera +Y) direction. Only an axis prior for the floor search and
    the last-resort up: a phone held upside down makes it point at the floor."""
    up = np.mean([m[:3, 1] for m in c2ws], axis=0)
    norm = np.linalg.norm(up)
    if norm < 1e-6:
        raise FrameError("The cameras disagree about which way is up.")
    return up / norm


def scene_scale(points: np.ndarray, centers: np.ndarray) -> float:
    return float(np.median(np.linalg.norm(centers - np.median(points, axis=0), axis=1)))


def fit_floor(
    points: np.ndarray, centers: np.ndarray, camera_up: np.ndarray, seed: int = SEED
) -> FloorPlane | None:
    """Largest plane with every camera on one side and its normal within
    MAX_FLOOR_TILT_DEG of the camera_up axis (either sign), normal toward the cameras;
    None when no plane qualifies."""
    pts = subsample(points)
    n = len(pts)
    if n < max(MIN_FLOOR_INLIERS, 3) or len(centers) == 0:
        return None
    tol = FLOOR_TOLERANCE_FRACTION * scene_scale(pts, centers)
    if not tol > 0:
        return None
    rng = np.random.default_rng(seed)
    tri = np.array([rng.choice(n, 3, replace=False) for _ in range(FLOOR_ITERATIONS)])
    a, b, c = pts[tri[:, 0]], pts[tri[:, 1]], pts[tri[:, 2]]
    normals = np.cross(b - a, c - a)
    norms = np.linalg.norm(normals, axis=1)
    ok = norms > 1e-12
    normals, a = normals[ok] / norms[ok, None], a[ok]
    offsets = np.einsum("ij,ij->i", normals, a)
    cos_max = np.cos(np.radians(MAX_FLOOR_TILT_DEG))
    best: FloorPlane | None = None
    for normal, offset in zip(normals, offsets, strict=True):
        if abs(normal @ camera_up) < cos_max:
            continue
        side = centers @ normal - offset
        if not (np.all(side > tol) or np.all(side < -tol)):
            continue
        count = int((np.abs(pts @ normal - offset) <= tol).sum())
        if best is None or count > best.inliers:
            best = FloorPlane(normal, float(offset), count, count / n)
    if best is None:
        return None
    normal, offset = best.normal, best.offset
    for _ in range(2):  # least-squares refinement on the inliers
        inl = pts[np.abs(pts @ normal - offset) <= tol]
        if len(inl) < 3:
            break
        mean = inl.mean(axis=0)
        refined = np.linalg.svd(inl - mean, full_matrices=False)[2][2]
        normal = refined if refined @ best.normal >= 0 else -refined
        offset = float(normal @ mean)
    side = centers @ normal - offset
    if np.all(side < 0):
        normal, offset, side = -normal, -offset, -side
    count = int((np.abs(pts @ normal - offset) <= tol).sum())
    if (
        not np.all(side > 0)
        or count < MIN_FLOOR_INLIERS
        or count / n < MIN_FLOOR_INLIER_FRACTION
        or abs(normal @ camera_up) < cos_max
    ):
        return None
    return FloorPlane(normal=normal, offset=offset, inliers=count, inlier_fraction=count / n)


def leg_membership(
    points: np.ndarray, c2ws: Sequence[np.ndarray], cameras: Sequence[Camera]
) -> np.ndarray | None:
    """Per point: inside the leg masks of more than half the masked views (None: no masks)."""
    counts = np.zeros(len(points), dtype=np.int64)
    masked = 0
    for c2w, cam in zip(c2ws, cameras, strict=True):
        if cam.mask is None:
            continue
        masked += 1
        uv, depth = project(c2w, cam.intrinsics, points)
        counts += (_in_frame(uv, depth, cam.width, cam.height) & cam.mask.contains(uv)).astype(
            np.int64
        )
    return counts > masked / 2.0 if masked else None


def leg_position(points: np.ndarray, member: np.ndarray | None) -> tuple[np.ndarray, str]:
    """Centroid of the leg points (leg_membership), else the cloud median."""
    if member is not None and member.sum() >= MIN_LEG_POINTS:
        return points[member].mean(axis=0), LEG_FROM_MASKS
    return np.median(points, axis=0), LEG_FROM_CLOUD


def floor_candidates(points: np.ndarray, member: np.ndarray | None) -> np.ndarray:
    """Points the floor fit may use: not leg points. A close-up cloud is mostly leg, and
    a flat strip of shin with every camera on one side would otherwise pass as floor."""
    return points if member is None else points[~member]


def leg_axis_angle_deg(
    points: np.ndarray, member: np.ndarray | None, up: np.ndarray
) -> float | None:
    """Angle between the leg points' long (first principal) axis and up; a diagnostic."""
    if member is None or member.sum() < MIN_LEG_POINTS:
        return None
    leg = points[member]
    axis = np.linalg.eigh(np.cov((leg - leg.mean(axis=0)).T))[1][:, -1]
    return float(np.degrees(np.arccos(np.clip(abs(axis @ up), 0.0, 1.0))))


@dataclass(frozen=True)
class LegAxisUp:
    up: np.ndarray  # unit, session frame, from the foot toward the knee
    views: int  # views whose centerline fed the axis
    votes: int  # views that voted on the foot end
    agreement: float  # share of the votes for the chosen end


def _grid_view(cam: Camera, mask: MaskLookup, c2w: np.ndarray) -> tuple[View, np.ndarray] | None:
    """The coarse mask as a silhouette View (intrinsics scaled to the grid) and its leg."""
    grid = np.where(mask.grid, 255, 0).astype(np.uint8)
    leg = leg_component(grid)
    if leg is None:
        return None
    fx, fy, cx, cy = cam.intrinsics
    k = float(mask.stride)
    view = View(str(cam.frame_id), grid, c2w, (fx / k, fy / k, cx / k, cy / k))
    return view, leg


def foot_vote(view: View, leg: np.ndarray, point: np.ndarray, direction: np.ndarray) -> int:
    """+1 if the foot is toward +direction in this view, -1 if toward -direction, 0 if
    the view cannot tell.

    The ankle is the narrowest part of the lower leg (about 0.6 of the calf's width,
    the knee about 0.9 to 1), so the narrowest band of the mask across the projected
    axis lies at the foot end. Bands touching the image border are skipped: their
    width is the frame's, not the leg's.
    """
    c2w = view.camera_to_world
    step = 0.05 * np.linalg.norm(point - c2w[:3, 3])
    uv, depth = project(c2w, view.intrinsics, np.array([point, point + step * direction]))
    if not (np.all(depth > 0) and np.all(np.isfinite(uv))):
        return 0
    d = uv[1] - uv[0]
    if not np.linalg.norm(d) > 1e-9:
        return 0
    d /= np.linalg.norm(d)
    rows, cols = np.nonzero(leg)
    q = (np.column_stack([cols, rows]) - uv[0]) @ d
    h, w = leg.shape
    on_border = (rows == 0) | (rows == h - 1) | (cols == 0) | (cols == w - 1)
    lo, hi = float(q.min()), float(q.max())
    if not hi - lo > FOOT_BANDS:
        return 0
    band = np.minimum(((q - lo) / (hi - lo) * FOOT_BANDS).astype(np.int64), FOOT_BANDS - 1)
    width = np.bincount(band, minlength=FOOT_BANDS).astype(np.float64)
    touches = np.bincount(band, weights=on_border, minlength=FOOT_BANDS) > 0
    centers = (np.arange(FOOT_BANDS) + 0.5) / FOOT_BANDS
    ok = ~touches & (centers >= FOOT_RANGE[0]) & (centers <= FOOT_RANGE[1]) & (width > 0)
    if ok.sum() < MIN_FOOT_BANDS:
        return 0
    narrowest = centers[ok][int(np.argmin(width[ok]))]
    return 1 if narrowest > 0.5 else -1


def leg_axis_up(cameras: Sequence[Camera], c2ws: Sequence[np.ndarray]) -> LegAxisUp | None:
    """Up without a floor: the leg axis triangulated from the mask centerlines (the
    silhouette math's own axis), pointing away from the foot end the masks vote for.

    None when the axis cannot be triangulated or the vote is empty or tied. A shin
    tilted from gravity is invisible this way: the silhouette tilt gate then sees 0.
    """
    found = []
    for cam, c2w in zip(cameras, c2ws, strict=True):
        if cam.mask is None:
            continue
        gv = _grid_view(cam, cam.mask, c2w)
        if gv is None:
            continue
        normal = centerline_normal(*gv)
        if normal is not None:
            found.append((gv, normal))
    if len(found) < MIN_VIEWS:
        return None
    normals = np.array([n for _, n in found])
    centers = np.array([gv[0].camera_to_world[:3, 3] for gv, _ in found])
    try:
        point, direction = triangulate_axis(normals, centers)
    except ReconstructionQualityError:
        return None
    votes = np.array([foot_vote(v, leg, point, direction) for (v, leg), _ in found])
    votes = votes[votes != 0]
    if len(votes) == 0 or votes.sum() == 0:
        return None
    toward = 1 if votes.sum() > 0 else -1
    return LegAxisUp(
        up=-toward * direction,
        views=len(found),
        votes=len(votes),
        agreement=float((votes == toward).mean()),
    )


def up_rotation(up: np.ndarray) -> np.ndarray:
    """Proper rotation taking unit `up` to +Y (rows are the world x, y, z axes)."""
    y = up / np.linalg.norm(up)
    helper = np.array([1.0, 0.0, 0.0]) if abs(y[0]) < 0.9 else np.array([0.0, 0.0, 1.0])
    x = helper - (helper @ y) * y
    x /= np.linalg.norm(x)
    return np.vstack([x, y, np.cross(x, y)])


def build_world(
    up: np.ndarray,
    leg: np.ndarray,
    centers: np.ndarray,
    floor: FloorPlane | None,
    camera_distance_m: float = NOMINAL_CAMERA_DISTANCE_M,
) -> WorldFrame:
    distance = float(np.median(np.linalg.norm(centers - leg, axis=1)))
    if not distance > 0:
        raise FrameError("The cameras sit on the leg position; the scene has no scale.")
    scale = camera_distance_m / distance
    floor_y = None if floor is None else scale * (floor.offset - floor.normal @ leg)
    return WorldFrame(rotation=up_rotation(up), origin=leg, scale=scale, floor_y=floor_y)


def joint_side(
    joints: Sequence[Mapping[str, tuple[float, float, float]]],
    lookups: Sequence[MaskLookup | None],
) -> str | None:
    """left/right: the side whose knee and ankle both fall inside the leg mask most often."""
    hits = {"left": 0, "right": 0}
    for found, lookup in zip(joints, lookups, strict=True):
        if lookup is None:
            continue
        for side in hits:
            knee, ankle = found.get(f"{side}_knee"), found.get(f"{side}_ankle")
            if knee is None or ankle is None:
                continue
            if lookup.contains(np.array([knee[:2], ankle[:2]])).all():
                hits[side] += 1
    if hits["left"] == hits["right"] == 0:
        return None
    return "left" if hits["left"] > hits["right"] else "right"


def view_joints(
    joints: Mapping[str, tuple[float, float, float]], side: str | None
) -> dict[str, tuple[float, float, float] | None] | None:
    if side is None:
        return None
    return {"knee": joints.get(f"{side}_knee"), "ankle": joints.get(f"{side}_ankle")}


def rescale_views(
    views: Sequence[View], floor_y: float | None, factor: float
) -> tuple[list[View], float | None]:
    """Scale the world about its origin: camera centers and floor height times factor."""
    out = []
    for v in views:
        c2w = v.camera_to_world.copy()
        c2w[:3, 3] *= factor
        out.append(replace(v, camera_to_world=c2w))
    return out, None if floor_y is None else floor_y * factor
