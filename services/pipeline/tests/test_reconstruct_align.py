from __future__ import annotations

import numpy as np
import pytest
from test_reconstruct_synthetic import camera_ring, similarity, to_photo_points, to_photo_poses

from forms_pipeline.reconstruct import ReconstructionQualityError
from forms_pipeline.reconstruct.align import (
    CAMERA_TO_WORLD,
    MAX_RESIDUAL_RMS_M,
    MIN_MATCHED_CAMERAS,
    WORLD_TO_CAMERA,
    align_poses,
    umeyama,
)


def test_umeyama_recovers_known_similarity() -> None:
    s, rot, t = similarity(3)
    dst = np.random.default_rng(0).normal(size=(30, 3))
    src = to_photo_points(dst, s, rot, t)
    s2, r2, t2 = umeyama(src, dst)
    assert s2 == pytest.approx(s)
    assert np.allclose(r2, rot, atol=1e-9)
    assert np.allclose(t2, t, atol=1e-9)


@pytest.mark.parametrize("convention", [CAMERA_TO_WORLD, WORLD_TO_CAMERA])
def test_both_pose_conventions_recover_metric_frame(convention: str) -> None:
    arkit = camera_ring()
    s, rot, t = similarity()
    photo = to_photo_poses(arkit, s, rot, t, convention=convention, noise_m=0.003)

    a = align_poses(photo, arkit, total_uploaded=len(arkit))

    assert a.convention == convention
    assert a.scale == pytest.approx(s, rel=0.02)
    assert a.residual_m < MAX_RESIDUAL_RMS_M
    point = np.array([[0.3, 0.25, -0.2]])
    assert np.allclose(a.apply(to_photo_points(point, s, rot, t)), point, atol=0.005)


def test_noise_free_alignment_is_exact() -> None:
    arkit = camera_ring()
    s, rot, t = similarity(7)
    a = align_poses(to_photo_poses(arkit, s, rot, t), arkit, total_uploaded=len(arkit))
    assert a.residual_m < 1e-9
    assert a.matched == len(arkit)


def test_residual_too_high_is_rescan() -> None:
    arkit = camera_ring()
    photo = to_photo_poses(arkit, *similarity(), noise_m=0.05)
    with pytest.raises(ReconstructionQualityError, match="did not line up"):
        align_poses(photo, arkit, total_uploaded=len(arkit))


def test_too_few_matched_cameras_is_rescan() -> None:
    arkit = camera_ring()
    photo = to_photo_poses(arkit, *similarity())
    trusted = dict(list(arkit.items())[: MIN_MATCHED_CAMERAS - 1])
    with pytest.raises(ReconstructionQualityError, match="camera tracking"):
        align_poses(photo, trusted, total_uploaded=len(arkit))


def test_too_few_registered_photos_is_rescan() -> None:
    arkit = camera_ring(40)
    photo = dict(list(to_photo_poses(arkit, *similarity()).items())[:19])
    with pytest.raises(ReconstructionQualityError, match="Only 19 of 40"):
        align_poses(photo, arkit, total_uploaded=40)


def test_degenerate_cameras_fail_as_rescan() -> None:
    same = np.eye(4)
    photo = {f"{i:03d}.jpg": same for i in range(20)}
    with pytest.raises(ReconstructionQualityError):
        align_poses(photo, camera_ring(20), total_uploaded=20)
