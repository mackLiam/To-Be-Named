"""forms.video-bundle v1 validation: the happy path and every hostile-input rule."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest
from harness_synth import HEIGHT, WIDTH, edit_manifest, scene, write_bundle
from test_silhouette import encode_png

from forms_pipeline.harness import HarnessBundleError
from forms_pipeline.harness.bundle import (
    MAX_POINTS,
    load_bundle,
    load_mask,
    load_points,
)


@pytest.fixture
def bundle_dir(tmp_path: Path) -> Path:
    return write_bundle(tmp_path / "b", scene())


def test_valid_bundle_loads(bundle_dir: Path) -> None:
    b = load_bundle(bundle_dir)
    assert len(b.frames) == 26
    assert b.photogrammetry.status == "ok"
    assert len(b.registered_frames) == 26
    f = b.frames[3]
    assert f.file == "frames/003.jpg"
    assert f.transform.shape == (4, 4)
    assert f.intrinsics[2:] == pytest.approx(((WIDTH - 1) / 2, (HEIGHT - 1) / 2))
    assert set(f.joints) == {"right_knee", "right_ankle", "left_knee", "left_ankle"}
    mask = load_mask(b, f, "person")
    assert mask.shape == (HEIGHT, WIDTH)
    assert np.array_equal(load_mask(b, f, "foreground"), mask)
    pts = load_points(b)
    assert pts.shape[1] == 3 and len(pts) == b.photogrammetry.points


def test_transform_is_read_column_major(bundle_dir: Path) -> None:
    sc = scene()
    assert np.allclose(load_bundle(bundle_dir).frames[0].transform, sc.c2w[0], atol=1e-9)


def _expect(bundle_dir: Path, match: str) -> None:
    with pytest.raises(HarnessBundleError, match=match):
        load_bundle(bundle_dir)


def test_wrong_format_or_version(bundle_dir: Path) -> None:
    edit_manifest(bundle_dir, lambda m: m.update(format="forms.photo-capture"))
    _expect(bundle_dir, "not forms.video-bundle version 1")
    edit_manifest(bundle_dir, lambda m: m.update(format="forms.video-bundle", version=2))
    _expect(bundle_dir, "version 1")


def test_missing_or_garbage_manifest(tmp_path: Path) -> None:
    _expect(tmp_path, "video.json is missing")
    (tmp_path / "video.json").write_bytes(b"\xff\xfe not json")
    _expect(tmp_path, "not UTF-8 JSON")
    (tmp_path / "video.json").write_text("[]")
    _expect(tmp_path, "must be an object")


def test_oversize_manifest(tmp_path: Path) -> None:
    (tmp_path / "video.json").write_bytes(b" " * (4 * 1024 * 1024 + 1))
    _expect(tmp_path, "larger than 4MB")


@pytest.mark.parametrize(
    "name", ["../outside.jpg", "frames/../../outside.jpg", "/etc/passwd", "frames/0.jpg"]
)
def test_frame_file_names_must_match_the_pattern(bundle_dir: Path, name: str) -> None:
    edit_manifest(bundle_dir, lambda m: m["frames"][0].update(file=name))
    _expect(bundle_dir, "frame.file must be frames/000.jpg")


def test_mask_file_name_traversal(bundle_dir: Path) -> None:
    edit_manifest(
        bundle_dir,
        lambda m: m["frames"][1]["masks"]["person"].update(file="masks/person/../../x.png"),
    )
    _expect(bundle_dir, "masks.person.file must be masks/person/001.png")


def test_symlink_out_of_the_bundle_is_rejected(bundle_dir: Path, tmp_path: Path) -> None:
    outside = tmp_path / "secret.jpg"
    outside.write_bytes((bundle_dir / "frames/000.jpg").read_bytes())
    (bundle_dir / "frames/000.jpg").unlink()
    os.symlink(outside, bundle_dir / "frames/000.jpg")
    _expect(bundle_dir, "frames/000.jpg is missing or outside the bundle")


def test_missing_frame_file(bundle_dir: Path) -> None:
    (bundle_dir / "frames/005.jpg").unlink()
    _expect(bundle_dir, "frames/005.jpg is missing")


def test_too_many_frames(bundle_dir: Path) -> None:
    edit_manifest(bundle_dir, lambda m: m.update(frames=m["frames"] * 8))
    _expect(bundle_dir, "more than 200 frames")


def test_duplicate_ids(bundle_dir: Path) -> None:
    edit_manifest(bundle_dir, lambda m: m["frames"].append(m["frames"][0]))
    _expect(bundle_dir, "not unique")


def test_frame_side_cap(bundle_dir: Path) -> None:
    edit_manifest(bundle_dir, lambda m: m["frames"][0].update(width=5000))
    _expect(bundle_dir, "frame.width must be an integer in 1..4096")


def test_frame_size_must_match_the_jpeg(bundle_dir: Path) -> None:
    edit_manifest(bundle_dir, lambda m: m["frames"][0].update(width=WIDTH + 2))
    _expect(bundle_dir, "does not match its manifest size")


def test_mask_size_mismatch(bundle_dir: Path) -> None:
    small = np.zeros((HEIGHT - 10, WIDTH), dtype=np.uint8)
    (bundle_dir / "masks/person/002.png").write_bytes(encode_png(small))
    _expect(bundle_dir, "masks/person/002.png is not the frame's size")


def test_corrupt_mask_fails_on_decode(bundle_dir: Path) -> None:
    b = load_bundle(bundle_dir)
    path = bundle_dir / "masks/person/004.png"
    data = bytearray(path.read_bytes())
    data[-20] ^= 0xFF  # inside IDAT/IEND: header still valid, body CRC broken
    path.write_bytes(bytes(data))
    with pytest.raises(HarnessBundleError, match="004.png is not an 8-bit grayscale PNG"):
        load_mask(b, b.frames[4], "person")


def test_points_cap_and_shape(bundle_dir: Path) -> None:
    path = bundle_dir / "points.f32"
    path.write_bytes(b"\x00" * 13)
    _expect(bundle_dir, "not whole x,y,z float32 triples")
    with path.open("wb") as fh:  # sparse: no real allocation
        fh.truncate((MAX_POINTS + 1) * 12)
    _expect(bundle_dir, "more than 2000000 points")


def test_non_finite_points_are_dropped(bundle_dir: Path) -> None:
    pts = np.array([[0, 0, 0], [np.nan, 1, 1], [1, np.inf, 0], [1, 2, 3]], dtype="<f4")
    (bundle_dir / "points.f32").write_bytes(pts.tobytes())
    assert load_points(load_bundle(bundle_dir)).tolist() == [[0, 0, 0], [1, 2, 3]]


def test_failed_photogrammetry_needs_a_known_kind_and_no_poses(tmp_path: Path) -> None:
    root = write_bundle(tmp_path / "f", scene(), status="failed", error="no_poses")
    b = load_bundle(root)
    assert b.photogrammetry.error == "no_poses" and not b.registered_frames
    edit_manifest(root, lambda m: m["photogrammetry"].update(error="Some framework text"))
    _expect(root, "not a known kind")
    edit_manifest(root, lambda m: m["photogrammetry"].update(error="timeout"))
    edit_manifest(
        root, lambda m: m["frames"][0].update(pose={"transform": np.eye(4).ravel().tolist()})
    )
    _expect(root, "pose is present although photogrammetry did not succeed")


def test_unknown_status(bundle_dir: Path) -> None:
    edit_manifest(bundle_dir, lambda m: m["photogrammetry"].update(status="maybe"))
    _expect(bundle_dir, "status is unknown")


def test_non_rigid_transform(bundle_dir: Path) -> None:
    def scale_pose(m: dict) -> None:
        m["frames"][0]["pose"]["transform"][0] = 2.0

    edit_manifest(bundle_dir, scale_pose)
    _expect(bundle_dir, "not a rigid transform")


def test_bad_numbers(bundle_dir: Path) -> None:
    edit_manifest(bundle_dir, lambda m: m["frames"][0].update(sharpness=True))
    _expect(bundle_dir, "frame.sharpness must be a finite number")


def test_unknown_joint_name(bundle_dir: Path) -> None:
    edit_manifest(bundle_dir, lambda m: m["frames"][0]["joints"].update(nose=[1, 2, 0.5]))
    _expect(bundle_dir, "unknown name")


def test_null_intrinsics_and_masks_are_allowed(bundle_dir: Path) -> None:
    def strip(m: dict) -> None:
        m["frames"][0]["pose"]["intrinsics"] = None
        m["frames"][1]["masks"]["person"] = None
        m["frames"][2]["pose"] = None

    edit_manifest(bundle_dir, strip)
    b = load_bundle(bundle_dir)
    assert b.frames[0].intrinsics is None
    assert load_mask(b, b.frames[1], "person") is None
    assert len(b.registered_frames) == 25
