"""The harness end to end on synthetic bundles, every failure row, results files and CLI.

Ratio tolerances (observed on these 240x320 renders, about 2.3 mm per pixel at the
leg, with 12 keyframes on a 150 degree arc): per-slice ratios within 0.005 of the
truth leg's, Leg_Length/OW_S3 within 0.017 (0.5%), width profile within 0.043
(its ends sit on the steep ankle and knee flanks, where a 1 mm shift of the
landmark moves the value most). Asserted with about 1.5x headroom.
"""

from __future__ import annotations

import functools
import json
import os
import stat
from pathlib import Path

import numpy as np
import pytest
import trimesh
from harness_synth import edit_manifest, random_similarity, scene, write_bundle
from test_silhouette import truth_mesh, truth_values

from forms_pipeline.extraction.mesh_loading import MeshValidationError
from forms_pipeline.harness import frame as fr
from forms_pipeline.harness import run
from forms_pipeline.harness.__main__ import main
from forms_pipeline.harness.metrics import PROFILE_KEY, agreement, shape_metrics, width_profile

SLICE_RATIO_TOL = 0.008
LEG_RATIO_TOL = 0.025
PROFILE_TOL = 0.07
OPTIONS = run.Options(max_keyframes=12)


@functools.lru_cache
def truth() -> dict:
    m = shape_metrics(truth_values())
    m["profile"] = width_profile(truth_mesh(), np.array([0.0, 1.0, 0.0]))
    return m


@pytest.fixture(scope="module")
def ok_rows(tmp_path_factory: pytest.TempPathFactory) -> dict[str, dict]:
    root = tmp_path_factory.mktemp("ok")
    plain = write_bundle(root / "plain", scene())
    moved = write_bundle(
        root / "moved", scene(), "w2c_opencv", random_similarity(3), intrinsics=False
    )
    return {
        "plain": run.analyze_bundle(plain, root / "out", OPTIONS),
        "moved": run.analyze_bundle(moved, root / "out", OPTIONS),
    }


@pytest.mark.parametrize(
    ("name", "convention", "intrinsics"),
    [("plain", "c2w_arkit", "pose"), ("moved", "w2c_opencv", "assumed")],
)
def test_synthetic_ratios_are_recovered(
    ok_rows: dict, name: str, convention: str, intrinsics: str
) -> None:
    row = ok_rows[name]
    assert row["status"] == "ok", row
    assert row["frame"]["convention"] == convention
    assert row["frame"]["up_source"] == fr.UP_FLOOR
    assert row["frame"]["intrinsics_source"] == intrinsics
    assert row["frame"]["joint_side"] == "right"
    assert row["mask_kind"] == "foreground"
    assert row["keyframes"]["used"] == 12 and row["keyframes"]["span_deg"] > 130
    assert row["silhouette"]["floor_used"] and row["silhouette"]["joints_used"] > 0
    assert row["metrics"]["nominal_Leg_Length_mm"] == pytest.approx(400.0, abs=15.0)
    assert row["gate_at_nominal_scale"] is None
    diffs = agreement(row["metrics"], truth())["diffs"]
    for key, diff in diffs.items():
        if key == PROFILE_KEY:
            assert diff < PROFILE_TOL, key
        elif key.startswith("Leg_Length"):
            assert diff < LEG_RATIO_TOL, key
        else:
            assert diff < SLICE_RATIO_TOL, key
    json.dumps(row)


def test_two_takes_of_the_same_leg_agree(ok_rows: dict) -> None:
    result = agreement(ok_rows["plain"]["metrics"], ok_rows["moved"]["metrics"])
    assert result["max"] < 0.01


@pytest.mark.parametrize("upside_down", [False, True])
def test_without_a_floor_up_comes_from_the_leg_axis(tmp_path: Path, upside_down: bool) -> None:
    """No floor in the cloud: up is the mask-triangulated leg axis, signed away from the
    foot. An upside-down phone (camera-mean image-up toward the floor) changes nothing."""
    sc = scene(floor=False, upside_down=upside_down)
    root = write_bundle(tmp_path / "nofloor", sc, "c2w_opencv", random_similarity(1))
    row = run.analyze_bundle(root, tmp_path / "out", run.Options(max_keyframes=8))
    assert row["status"] == "ok", row
    assert row["frame"]["up_source"] == fr.UP_LEG_AXIS
    assert row["frame"]["tilt_gate_exercised"] is False
    assert row["frame"]["up_foot_vote_agreement"] == 1.0
    assert (row["frame"]["up_vs_camera_mean_deg"] > 170.0) is upside_down
    assert row["silhouette"]["floor_used"] is False
    assert row["silhouette"]["axis_tilt_deg"] < 2.0  # up is the axis itself
    for key, diff in agreement(row["metrics"], truth())["diffs"].items():
        if key == PROFILE_KEY:
            assert diff < PROFILE_TOL, key
        elif key.startswith("Leg_Length"):
            assert diff < LEG_RATIO_TOL, key
        else:
            assert diff < SLICE_RATIO_TOL, key


# --- failure rows ------------------------------------------------------------------


def _row(root: Path, tmp_path: Path) -> dict:
    row = run.analyze_bundle(root, tmp_path / "out", OPTIONS)
    assert row["status"] == "failed"
    json.dumps(row)
    return row


def test_malformed_bundle_is_a_bundle_row(tmp_path: Path) -> None:
    root = write_bundle(tmp_path / "b", scene())
    edit_manifest(root, lambda m: m.update(format="nope"))
    row = _row(root, tmp_path)
    assert row["stage"] == "bundle" and "not forms.video-bundle version 1" in row["reason"]


def test_corrupt_mask_is_a_bundle_row(tmp_path: Path) -> None:
    root = write_bundle(tmp_path / "b", scene())
    path = root / "masks/foreground/007.png"
    data = bytearray(path.read_bytes())
    data[-20] ^= 0xFF
    path.write_bytes(bytes(data))
    row = _row(root, tmp_path)
    assert row["stage"] == "bundle" and "007.png is not an 8-bit grayscale PNG" in row["reason"]


def test_failed_photogrammetry_row(tmp_path: Path) -> None:
    root = write_bundle(tmp_path / "b", scene(), status="failed", error="no_poses")
    row = _row(root, tmp_path)
    assert (row["stage"], row["reason"]) == ("photogrammetry", "Photogrammetry failed (no_poses).")
    assert row["masks"]["foreground"]["frames_with_mask"] == 26  # quality still reported


def test_too_few_registered_frames_row(tmp_path: Path) -> None:
    root = write_bundle(tmp_path / "b", scene(), registered={0, 1})
    row = _row(root, tmp_path)
    assert row["stage"] == "photogrammetry"
    assert row["reason"] == "Only 2 of 26 frames registered; at least 3 are needed."
    assert row["registration"]["frames_with_pose"] == 2


def test_missing_point_cloud_row(tmp_path: Path) -> None:
    root = write_bundle(tmp_path / "b", scene(), points=False)
    row = _row(root, tmp_path)
    assert row["stage"] == "frame" and row["reason"].startswith("No point cloud")


def test_no_masks_of_the_chosen_kind_is_a_keyframes_row(tmp_path: Path) -> None:
    root = write_bundle(tmp_path / "b", scene(), foreground=False)
    row = _row(root, tmp_path)
    assert row["stage"] == "keyframes" and row["reason"].startswith("Only 0 keyframes")
    ok = run.analyze_bundle(
        root, tmp_path / "out", run.Options(max_keyframes=3, mask_kind="person")
    )
    assert ok["mask_kind"] == "person" and ok["stage"] != "keyframes"


def test_production_retake_reason_is_recorded_verbatim(tmp_path: Path) -> None:
    root = write_bundle(tmp_path / "b", scene(n_frames=8, arc_deg=60.0))
    row = _row(root, tmp_path)
    assert row["stage"] == "silhouette pass 1"
    assert row["reason"] == (
        "The photos must go around the front of the leg, from the inner to the outer side. "
        "Please retake the photos."
    )


def test_unexpected_error_is_a_row_not_a_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_args: object) -> None:
        raise ZeroDivisionError("division by zero")

    monkeypatch.setattr(fr, "resolve_convention", boom)
    row = _row(write_bundle(tmp_path / "b", scene()), tmp_path)
    assert row["stage"] == "frame"
    assert row["reason"] == "Unexpected ZeroDivisionError: division by zero"


def test_measure_uses_the_production_mesh_gates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    flat = trimesh.Trimesh(
        vertices=[[0, 0, 0], [0.1, 0, 0], [0.2, 0, 0], [0.3, 0, 0]], faces=[[0, 1, 2], [1, 2, 3]]
    )
    with pytest.raises(MeshValidationError, match="degenerate"):
        run.measure_mesh(flat, tmp_path / "work")
    assert list((tmp_path / "work").iterdir()) == []  # temp dir cleaned up

    class Tiny:
        max_mesh_bytes = 10
        max_mesh_mb = 0

    monkeypatch.setattr(run, "get_settings", lambda: Tiny())
    with pytest.raises(MeshValidationError, match="exceeds the 0MB limit"):
        run.measure_mesh(truth_mesh(), tmp_path / "work")


def test_options_are_validated() -> None:
    with pytest.raises(ValueError, match="max_keyframes"):
        run.Options(max_keyframes=2)
    with pytest.raises(ValueError, match="mask_kind"):
        run.Options(mask_kind="depth")


# --- run over a videos directory, results files, CLI --------------------------------


def _tree(root: Path, skip: Path) -> set[str]:
    return {str(p) for p in root.rglob("*") if skip not in p.parents and p != skip}


def test_run_videos_writes_results_only_in_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ok_rows: dict
) -> None:
    videos, bundles, out = tmp_path / "videos", tmp_path / "bundles", tmp_path / "out"
    videos.mkdir()
    for name in ("A.MOV", "B.mp4", "notes.txt"):
        (videos / name).write_bytes(b"x")
    for stem in ("A", "B"):
        (bundles / stem).mkdir(parents=True)
        (bundles / stem / "video.json").write_text("{}")
    canned = {"A": ok_rows["plain"], "B": ok_rows["moved"]}
    monkeypatch.setattr(
        run, "analyze_bundle", lambda d, _out, _opts: {**canned[Path(d).name], "bundle": d.name}
    )
    before = _tree(tmp_path, out)
    rows = run.run_videos(videos, out, bundles, tool=tmp_path / "absent", reuse=True)
    assert _tree(tmp_path, out) == before
    assert sorted(p.name for p in out.iterdir()) == ["results.json", "results.md"]
    assert [r["video"] for r in rows] == ["A.MOV", "B.mp4"]

    payload = json.loads((out / "results.json").read_text())
    (pair,) = payload["agreement_assumed_same_leg"]
    assert (pair["a"], pair["b"]) == ("A", "B") and pair["max"] < 0.01
    md = (out / "results.md").read_text()
    assert "## Agreement (assumed same leg)" in md
    assert "| A vs B |" in md
    assert "nominal OW mm" in md and "not real sizes" in md
    assert "\u2014" not in md and "\u2013" not in md


def _fake_tool(path: Path, body: str) -> Path:
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def test_forms_video_failures_become_bundle_rows(tmp_path: Path) -> None:
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "A.MOV").write_bytes(b"x")
    out = tmp_path / "out"

    rows = run.run_videos(videos, out, tmp_path / "bundles", tool=tmp_path / "absent")
    assert rows[0]["stage"] == "bundle" and "forms-video is not built" in rows[0]["reason"]

    failing = _fake_tool(
        tmp_path / "fail.sh",
        'echo "free text /private/path" >&2\necho \'{"error":"decode"}\' >&2\nexit 3\n',
    )
    rows = run.run_videos(videos, out, tmp_path / "bundles", tool=failing)
    assert rows[0]["reason"] == "forms-video exited with code 3 (decode)."
    assert "/private/path" not in (out / "results.md").read_text()

    # Called with list argv: --video <file> --out <dir> --timeout-s N; writes a bad manifest.
    writer = _fake_tool(tmp_path / "ok.sh", 'echo "{}" > "$4/video.json"\necho "$@" > "$4/args"\n')
    rows = run.run_videos(videos, out, tmp_path / "bundles", tool=writer, timeout_s=30)
    args = (tmp_path / "bundles/A/args").read_text().split()
    assert args == ["--video", str(videos / "A.MOV"), "--out", str(tmp_path / "bundles/A"),
                    "--timeout-s", "30"]  # fmt: skip
    assert rows[0]["stage"] == "bundle" and "not forms.video-bundle" in rows[0]["reason"]


def test_cli_analyze_and_bad_arguments(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    root = write_bundle(tmp_path / "pf", scene(), status="failed", error="timeout")
    out = tmp_path / "out"
    assert main(["analyze", "--bundle", str(root), "--out", str(out)]) == 0
    row = json.loads((out / "pf.json").read_text())
    assert row["stage"] == "photogrammetry" and row["mask_kind"] == "foreground"
    assert "Photogrammetry failed (timeout)." in capsys.readouterr().out
    assert main(["run", "--videos", str(tmp_path / "none"), "--out", str(out)]) == 2
    assert main(["analyze", "--bundle", str(root), "--max-keyframes", "1"]) == 2
    assert os.listdir(out) == ["pf.json"]
