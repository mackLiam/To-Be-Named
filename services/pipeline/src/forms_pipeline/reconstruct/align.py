"""Similarity alignment of the photogrammetry frame onto the ARKit world frame.

PhotogrammetrySession output has arbitrary scale (root CLAUDE.md gotcha 4). The
phone's ARKit camera positions are metric and gravity-aligned, so fitting a
similarity transform (Umeyama 1991) from photogrammetry camera positions to ARKit
camera positions gives the mesh real meters and Y-up in one step.

RealityKit does not clearly document whether Pose.transform is camera-to-world or
world-to-camera, so both readings are fitted and the lower residual wins; the
winner is recorded in the job artifacts.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from forms_pipeline.reconstruct import ReconstructionQualityError

# Tuning values, not physical constants: revisit against real captures.
MIN_MATCHED_CAMERAS = 12
MIN_REGISTERED_FRACTION = 0.5
MAX_RESIDUAL_RMS_M = 0.02

CAMERA_TO_WORLD = "camera_to_world"
WORLD_TO_CAMERA = "world_to_camera"

_RESCAN = "Please rescan, moving slowly all the way around the leg in good light."


@dataclass(frozen=True)
class Alignment:
    scale: float
    rotation: np.ndarray  # 3x3
    translation: np.ndarray  # 3
    residual_m: float
    convention: str
    matched: int

    def apply(self, points: np.ndarray) -> np.ndarray:
        return self.scale * points @ self.rotation.T + self.translation


def umeyama(src: np.ndarray, dst: np.ndarray) -> tuple[float, np.ndarray, np.ndarray]:
    """Least-squares (s, R, t) with dst ~= s * R @ src + t. Proper rotation only."""
    mu_s, mu_d = src.mean(axis=0), dst.mean(axis=0)
    xs, xd = src - mu_s, dst - mu_d
    var_s = float((xs**2).sum() / len(src))
    cov = xd.T @ xs / len(src)
    u, d, vt = np.linalg.svd(cov)
    sign = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        sign[2, 2] = -1.0
    rotation = u @ sign @ vt
    scale = float(np.trace(np.diag(d) @ sign) / var_s) if var_s > 0 else float("nan")
    translation = mu_d - scale * rotation @ mu_s
    return scale, rotation, translation


def camera_position(transform: np.ndarray, convention: str) -> np.ndarray:
    if convention == CAMERA_TO_WORLD:
        return transform[:3, 3]
    rot, t = transform[:3, :3], transform[:3, 3]
    return -rot.T @ t


def _fit(src: np.ndarray, dst: np.ndarray, convention: str) -> Alignment:
    s, r, t = umeyama(src, dst)
    residual = s * src @ r.T + t - dst
    rms = float(np.sqrt((residual**2).sum(axis=1).mean()))
    return Alignment(s, r, t, rms, convention, len(src))


def align_poses(
    photo_poses: dict[str, np.ndarray],
    arkit_camera_to_world: dict[str, np.ndarray],
    total_uploaded: int,
) -> Alignment:
    """Fit photogrammetry frame -> ARKit world and enforce the quality gates.

    `photo_poses` is every sample the session registered; `arkit_camera_to_world`
    holds only the cameras trusted for alignment (e.g. normal tracking).
    """
    registered = len(photo_poses)
    if total_uploaded <= 0 or registered / total_uploaded < MIN_REGISTERED_FRACTION:
        raise ReconstructionQualityError(
            f"Only {registered} of {total_uploaded} photos could be used. {_RESCAN}"
        )
    keys = sorted(photo_poses.keys() & arkit_camera_to_world.keys())
    if len(keys) < MIN_MATCHED_CAMERAS:
        raise ReconstructionQualityError(
            f"Only {len(keys)} photos had usable camera tracking. {_RESCAN}"
        )

    dst = np.array([arkit_camera_to_world[k][:3, 3] for k in keys])
    fits = [
        _fit(np.array([camera_position(photo_poses[k], c) for k in keys]), dst, c)
        for c in (CAMERA_TO_WORLD, WORLD_TO_CAMERA)
    ]
    fits = [f for f in fits if np.isfinite(f.scale) and f.scale > 0 and np.isfinite(f.residual_m)]
    if not fits:
        raise ReconstructionQualityError(f"The photos could not be scaled. {_RESCAN}")
    best = min(fits, key=lambda f: f.residual_m)
    if best.residual_m > MAX_RESIDUAL_RMS_M:
        raise ReconstructionQualityError(
            f"The photos did not line up with the phone's motion "
            f"({best.residual_m:.3f}m error). {_RESCAN}"
        )
    return best
