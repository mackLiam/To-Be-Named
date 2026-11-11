"""The harness shell: videos -> forms-video bundles -> analysis rows -> results files.

analyze_bundle runs one bundle through the stages in STAGES and returns a row;
every failure becomes a row carrying its stage and the exact reason the code
raised, so one bad video never stops a run. Only the out directory is written
(results files plus a short-lived measuring temp dir); forms-video writes its
own bundle directory. Nothing touches the network.
"""

from __future__ import annotations

import itertools
import json
import math
import subprocess
import tempfile
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import trimesh

from forms_pipeline.config import get_settings
from forms_pipeline.contract import validate_measurements
from forms_pipeline.extraction.measure import MeasurementError, extract_measurements
from forms_pipeline.extraction.mesh_loading import MeshValidationError, load_mesh
from forms_pipeline.harness import HarnessBundleError
from forms_pipeline.harness import estimate as est
from forms_pipeline.harness import frame as fr
from forms_pipeline.harness.bundle import (
    JOINT_NAMES,
    MASK_KINDS,
    MAX_FRAMES,
    VideoBundle,
    load_bundle,
    load_mask,
    load_points,
)
from forms_pipeline.harness.keyframes import (
    DEFAULT_MAX_KEYFRAMES,
    Candidate,
    KeyframeChoice,
    azimuths_deg,
    choose_keyframes,
)
from forms_pipeline.harness.metrics import (
    SLICES,
    MaskStats,
    agreement,
    mask_stats,
    mask_summary,
    shape_metrics,
    width_profile,
)
from forms_pipeline.reconstruct import ReconstructionQualityError
from forms_pipeline.reconstruct.handler import export_obj_mm
from forms_pipeline.reconstruct.silhouette import MIN_VIEWS, View, reconstruct_silhouette

PIPELINE_ROOT = Path(__file__).resolve().parents[3]
RECORDINGS = PIPELINE_ROOT / "recordings"
DEFAULT_VIDEOS = RECORDINGS / "videos"
DEFAULT_BUNDLES = RECORDINGS / "bundles"
DEFAULT_OUT = RECORDINGS / "harness"
DEFAULT_FORMS_VIDEO = PIPELINE_ROOT.parent / "reconstruct" / ".build" / "release" / "forms-video"
VIDEO_SUFFIXES = frozenset({".mov", ".mp4"})
# forms-video bounds itself with --timeout-s; the grace is a backstop for a wedged process.
FORMS_VIDEO_TIMEOUT_S = 1800.0
# Frames forms-video samples from a video (its own default is 60). Dense sampling lets
# photogrammetry register the bad stretches: 2026-11-11, at 120 frames IMG_3834 and
# IMG_3836 registered 119/120 and 103/103 against 44/60 and 38/60 at 60.
FORMS_VIDEO_MAX_FRAMES = 120
MIN_FORMS_VIDEO_FRAMES = 10  # forms-video's own --max-frames range is 10...200
SUBPROCESS_GRACE_S = 60.0
# Pass 2 runs the silhouette math at a realistic leg size so its metric thresholds
# (search radius, minimum semi-axis, Leg_Length range) act as they would on a phone.
NOMINAL_LEG_LENGTH_M = 0.400
MAX_REASON_CHARS = 400

STAGES = (
    "bundle",
    "photogrammetry",
    "frame",
    "keyframes",
    "silhouette pass 1",
    "silhouette pass 2",
    "measure",
)
# Runs after a successful measure; its failures stay inside row["estimator"].
REPORT_ONLY_STAGES = ("estimator",)
OK = "ok"
FAILED = "failed"
_EXPECTED = (
    HarnessBundleError,
    fr.FrameError,
    ReconstructionQualityError,
    MeshValidationError,
    MeasurementError,
)


class StageError(RuntimeError):
    """A harness-level failure (not raised by production code); message is the reason."""


@dataclass(frozen=True)
class Options:
    max_keyframes: int = DEFAULT_MAX_KEYFRAMES
    # Vision's foreground instance isolates a close-up leg better than the person mask
    # (real bundles 2026-11-11: median area 0.46 / 0.39 against 0.61 / 0.45).
    mask_kind: str = "foreground"

    def __post_init__(self) -> None:
        if self.max_keyframes < MIN_VIEWS:
            raise ValueError(f"max_keyframes must be at least {MIN_VIEWS}")
        if self.mask_kind not in MASK_KINDS:
            raise ValueError(f"mask_kind must be one of {MASK_KINDS}")


def _clean(value: Any) -> Any:
    """JSON-safe copy: numpy scalars to float, non-finite to None, floats rounded."""
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_clean(v) for v in value]
    if isinstance(value, bool | np.bool_):
        return bool(value)
    if isinstance(value, int | np.integer):
        return int(value)
    if isinstance(value, float | np.floating):
        return round(float(value), 4) if math.isfinite(value) else None
    return value


def measure_mesh(
    mesh_m: trimesh.Trimesh, work_dir: Path
) -> tuple[dict[str, float], str | None, trimesh.Trimesh]:
    """The measuring step's path (reconstruct.handler._publish then jobs.runner.
    handle_measuring): OBJ in mm, size cap, load_mesh, extract_measurements, gates.

    Returns the values, the gate reason the measuring step would raise (None when
    the gates pass) and the loaded mm mesh that was measured. The gates are not fatal
    here: the harness's scale is nominal.
    TODO(liam): decide whether a gate failure at nominal scale should fail the row.
    """
    settings = get_settings()
    obj = export_obj_mm(mesh_m)
    if len(obj) > settings.max_mesh_bytes:
        raise MeshValidationError(
            f"Reconstructed mesh exceeds the {settings.max_mesh_mb}MB limit. Please rescan."
        )
    work_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".measure-", dir=work_dir) as tmp:
        path = Path(tmp) / "mesh.obj"
        path.write_bytes(obj)
        mesh_mm = load_mesh(path)
        result = extract_measurements(mesh_mm)
    violations = validate_measurements(result.values)
    gate = (
        "Measurements outside plausible range, please rescan: " + "; ".join(violations)
        if violations
        else None
    )
    return result.values, gate, mesh_mm


def _first_pass(
    bundle: VideoBundle, kind: str
) -> tuple[dict[str, list[MaskStats | None]], dict[int, fr.MaskLookup], dict[str, int]]:
    """Decode every mask once: quality stats per kind, a coarse lookup of `kind` per frame."""
    stats: dict[str, list[MaskStats | None]] = {k: [] for k in MASK_KINDS}
    lookups: dict[int, fr.MaskLookup] = {}
    joints_seen: Counter[str] = Counter({name: 0 for name in JOINT_NAMES})
    for f in bundle.frames:
        joints_seen.update(f.joints.keys())
        for k in MASK_KINDS:
            mask = load_mask(bundle, f, k)
            stats[k].append(None if mask is None else mask_stats(mask))
            if mask is not None and k == kind:
                lookups[f.id] = fr.MaskLookup.from_mask(mask)
    return stats, lookups, dict(joints_seen)


def _registration(bundle: VideoBundle) -> dict[str, Any]:
    pg = bundle.photogrammetry
    return {
        "status": pg.status,
        "error": pg.error,
        "submitted": pg.submitted,
        "registered": pg.registered,
        "frames_with_pose": len(bundle.registered_frames),
        "frames": len(bundle.frames),
        "points": pg.points,
        "convention_reported": pg.convention,
    }


def _keyframes(
    bundle: VideoBundle,
    c2ws: dict[int, np.ndarray],
    world: fr.WorldFrame,
    options: Options,
) -> KeyframeChoice:
    eligible = [f for f in bundle.registered_frames if f.masks.get(options.mask_kind) is not None]
    if not eligible:
        return choose_keyframes([], options.max_keyframes)
    centers = np.array([world.point(c2ws[f.id][:3, 3]) for f in eligible])
    az = azimuths_deg(centers, np.zeros(3))
    candidates = [
        Candidate(frame_id=f.id, azimuth_deg=float(a), sharpness=f.sharpness)
        for f, a in zip(eligible, az, strict=True)
    ]
    return choose_keyframes(candidates, options.max_keyframes)


def analyze_bundle(bundle_dir: Path, work_dir: Path, options: Options | None = None) -> dict:
    """One bundle -> one result row (never raises for bundle or reconstruction problems)."""
    options = options or Options()
    row: dict[str, Any] = {
        "bundle": Path(bundle_dir).name,
        "status": FAILED,
        "mask_kind": options.mask_kind,
    }
    stage = "bundle"
    try:
        bundle = load_bundle(bundle_dir)
        row["registration"] = _registration(bundle)
        stats, lookups, joints_seen = _first_pass(bundle, options.mask_kind)
        row["masks"] = mask_summary(stats, joints_seen, len(bundle.frames))

        stage = "photogrammetry"
        pg = bundle.photogrammetry
        if pg.status != "ok":
            detail = f" ({pg.error})" if pg.error else ""
            raise StageError(f"Photogrammetry {pg.status}{detail}.")
        registered = bundle.registered_frames
        if len(registered) < MIN_VIEWS:
            raise StageError(
                f"Only {len(registered)} of {len(bundle.frames)} frames registered; "
                f"at least {MIN_VIEWS} are needed."
            )

        stage = "frame"
        points = load_points(bundle)
        if points is None or len(points) == 0:
            raise StageError("No point cloud; the pose convention cannot be resolved.")
        cams, sources = [], Counter()
        for f in registered:
            intr, source = fr.frame_intrinsics(f.intrinsics, f.width, f.height)
            sources[source] += 1
            cams.append(fr.Camera(f.id, f.transform, intr, f.width, f.height, lookups.get(f.id)))
        convention = fr.resolve_convention(cams, points)
        c2w_session = {
            c.frame_id: fr.to_camera_to_world(c.transform, convention.name) for c in cams
        }
        centers = np.array([c2w_session[c.frame_id][:3, 3] for c in cams])
        camera_up = fr.camera_mean_up(list(c2w_session.values()))
        pts = fr.subsample(points)
        member = fr.leg_membership(pts, [c2w_session[c.frame_id] for c in cams], cams)
        axis_up = fr.leg_axis_up(cams, [c2w_session[c.frame_id] for c in cams])
        floor = fr.fit_floor(
            fr.floor_candidates(pts, member),
            centers,
            camera_up,
            leg=None if member is None else pts[member],
            leg_up=None if axis_up is None else axis_up.up,
        )
        if floor is not None:
            up, up_source = floor.normal, fr.UP_FLOOR
        elif axis_up is not None:
            up, up_source = axis_up.up, fr.UP_LEG_AXIS
        else:
            up, up_source = camera_up, fr.UP_CAMERA_MEAN
        leg, leg_source = fr.leg_position(pts, member)
        world = fr.build_world(up, leg, centers, floor)
        row["frame"] = {
            "convention": convention.name,
            "convention_in_view": convention.in_view,
            "convention_coverage": convention.coverage,
            "convention_scores": convention.scores,
            "up_source": up_source,
            # Only a floor is independent of the leg; otherwise the tilt gate reads ~0.
            "tilt_gate_exercised": floor is not None,
            "up_foot_vote_agreement": None if axis_up is None else axis_up.agreement,
            "leg_axis_vs_up_from_masks_deg": (
                None
                if axis_up is None
                else float(np.degrees(np.arccos(np.clip(axis_up.up @ up, -1.0, 1.0))))
            ),
            "floor_inlier_fraction": None if floor is None else floor.inlier_fraction,
            "up_vs_camera_mean_deg": float(
                np.degrees(np.arccos(np.clip(up @ camera_up, -1.0, 1.0)))
            ),
            "leg_source": leg_source,
            "leg_points_fraction": None if member is None else float(member.mean()),
            "leg_axis_vs_up_deg": fr.leg_axis_angle_deg(pts, member, up),
            "intrinsics_source": (
                sources.most_common(1)[0][0] if len(sources) == 1 else dict(sources)
            ),
        }

        stage = "keyframes"
        choice = _keyframes(bundle, c2w_session, world, options)
        row["keyframes"] = {
            "used": len(choice.frame_ids),
            "candidates": choice.candidates,
            "blurry": choice.blurry,
            "span_deg": choice.span_deg,
            "frame_ids": list(choice.frame_ids),
        }
        if len(choice.frame_ids) < MIN_VIEWS:
            raise StageError(
                f"Only {len(choice.frame_ids)} keyframes are sharp, masked and spread out; "
                f"at least {MIN_VIEWS} are needed."
            )
        by_id = {f.id: f for f in registered}
        cam_by_id = {c.frame_id: c for c in cams}
        side = fr.joint_side(
            [by_id[i].joints for i in choice.frame_ids],
            [lookups.get(i) for i in choice.frame_ids],
        )
        row["frame"]["joint_side"] = side
        views = []
        for n, frame_id in enumerate(choice.frame_ids):
            f = by_id[frame_id]
            views.append(
                View(
                    station=f"kf{n:02d}",
                    mask=load_mask(bundle, f, options.mask_kind),
                    camera_to_world=world.camera_to_world(c2w_session[frame_id]),
                    intrinsics=cam_by_id[frame_id].intrinsics,
                    joints=fr.view_joints(f.joints, side),
                )
            )

        stage = "silhouette pass 1"
        first = reconstruct_silhouette(views, floor_y=world.floor_y)

        stage = "silhouette pass 2"
        factor = NOMINAL_LEG_LENGTH_M / first.artifacts["leg_length_m"]
        views2, floor2 = fr.rescale_views(views, world.floor_y, factor)
        second = reconstruct_silhouette(views2, floor_y=floor2)
        art = second.artifacts
        row["silhouette"] = {
            "views_used": art["views_used"],
            "azimuth_span_deg": art["azimuth_span_deg"],
            "axis_tilt_deg": art["axis_tilt_deg"],
            "view_correction_max_deg": art["view_correction_max_deg"],
            "residual_median_nominal_m": art["residual_median_m"],
            "joints_used": art["joints_used"],
            "floor_used": art["floor_used"],
            "pass1_views_used": first.artifacts["views_used"],
            "silhouette_version": art["silhouette_version"],
            "views_axis": art["views_axis"],
            "edges_at_border_fraction": art["edges_at_border_fraction"],
            "views_cut_off_below": art["views_cut_off_below"],
            "views_cut_off_above": art["views_cut_off_above"],
        }

        stage = "measure"
        values, gate, mesh_mm = measure_mesh(second.mesh, work_dir)
        metrics = shape_metrics(values)
        metrics["profile"] = width_profile(second.mesh, np.array(art["axis_direction"]))
        row["metrics"] = metrics
        row["gate_at_nominal_scale"] = gate
        row["status"] = OK
        row["stage"] = None
        row["reason"] = None
        row["estimator"] = est.estimator_stage(mesh_mm, art["azimuth_span_deg"], values)
    except (StageError, *_EXPECTED) as exc:
        row["stage"], row["reason"] = stage, str(exc)[:MAX_REASON_CHARS]
    except Exception as exc:  # noqa: BLE001 - one bundle must never stop the run
        row["stage"] = stage
        row["reason"] = f"Unexpected {type(exc).__name__}: {exc}"[:MAX_REASON_CHARS]
    return _clean(row)


def _error_kind(stderr: bytes) -> str:
    """forms-video's machine-readable error kind only; its free text is not echoed."""
    try:
        kind = json.loads(stderr.decode("utf-8", "replace").strip().splitlines()[-1]).get("error")
    except (IndexError, ValueError, AttributeError):
        return "unknown"
    return kind if isinstance(kind, str) and kind.isidentifier() and len(kind) <= 32 else "unknown"


def run_forms_video(
    tool: Path,
    video: Path,
    bundle_dir: Path,
    timeout_s: float = FORMS_VIDEO_TIMEOUT_S,
    max_frames: int = FORMS_VIDEO_MAX_FRAMES,
) -> None:
    """Run forms-video for one video. Raises StageError with a short reason."""
    if not MIN_FORMS_VIDEO_FRAMES <= max_frames <= MAX_FRAMES:
        raise ValueError(f"max_frames must be between {MIN_FORMS_VIDEO_FRAMES} and {MAX_FRAMES}")
    if not tool.is_file():
        raise StageError(
            "forms-video is not built (swift build -c release in services/reconstruct)."
        )
    bundle_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(tool),
        "--video",
        str(video),
        "--out",
        str(bundle_dir),
        "--timeout-s",
        str(int(timeout_s)),
        "--max-frames",
        str(int(max_frames)),
    ]
    try:
        proc = subprocess.run(  # noqa: S603 - list argv, no shell, paths we chose
            cmd, capture_output=True, timeout=timeout_s + SUBPROCESS_GRACE_S, check=False
        )
    except subprocess.TimeoutExpired as exc:
        raise StageError("forms-video timed out.") from exc
    except OSError as exc:
        raise StageError("forms-video could not be started.") from exc
    if proc.returncode != 0:
        raise StageError(
            f"forms-video exited with code {proc.returncode} ({_error_kind(proc.stderr)})."
        )


def find_videos(videos_dir: Path) -> list[Path]:
    return sorted(
        p for p in videos_dir.iterdir() if p.is_file() and p.suffix.lower() in VIDEO_SUFFIXES
    )


def run_videos(
    videos_dir: Path,
    out_dir: Path,
    bundles_dir: Path = DEFAULT_BUNDLES,
    tool: Path = DEFAULT_FORMS_VIDEO,
    reuse: bool = False,
    options: Options | None = None,
    timeout_s: float = FORMS_VIDEO_TIMEOUT_S,
    max_frames: int = FORMS_VIDEO_MAX_FRAMES,
) -> list[dict]:
    """Every video in videos_dir -> rows; writes out_dir/results.json and results.md."""
    options = options or Options()
    rows = []
    for video in find_videos(videos_dir):
        bundle_dir = bundles_dir / video.stem
        if not (reuse and (bundle_dir / "video.json").is_file()):
            try:
                run_forms_video(tool, video, bundle_dir, timeout_s, max_frames)
            except StageError as exc:
                rows.append(
                    {"video": video.name, "bundle": video.stem, "status": FAILED,
                     "stage": "bundle", "reason": str(exc)}
                )  # fmt: skip
                continue
        row = analyze_bundle(bundle_dir, out_dir, options)
        rows.append({"video": video.name, **row})
    write_results(rows, out_dir)
    return rows


def agreements(rows: Sequence[dict]) -> list[dict]:
    ok = [r for r in rows if r.get("status") == OK]
    return [
        {"a": a["bundle"], "b": b["bundle"], **agreement(a["metrics"], b["metrics"])}
        for a, b in itertools.combinations(ok, 2)
    ]


def write_results(rows: Sequence[dict], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    pairs = _clean(agreements(rows))
    payload = {"rows": list(rows), "agreement_assumed_same_leg": pairs}
    (out_dir / "results.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    (out_dir / "results.md").write_text(render_markdown(rows, pairs), encoding="utf-8")


def _fmt(value: Any, digits: int = 3) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    if isinstance(value, dict):
        return ", ".join(f"{k} {_fmt(v, digits)}" for k, v in value.items())
    return str(value).replace("|", "/").replace("\n", " ")


def _row_markdown(row: dict) -> list[str]:
    name = row.get("video") or row.get("bundle")
    lines = [f"## {name}", ""]
    if row.get("status") != OK:
        lines += [f"Failed at stage **{row.get('stage')}**: {row.get('reason')}", ""]
    reg, masks = row.get("registration"), row.get("masks")
    frame, kf, sil = row.get("frame"), row.get("keyframes"), row.get("silhouette")
    facts = []
    if reg:
        facts.append(("registered / submitted", f"{reg['registered']} / {reg['submitted']}"))
        facts.append(("frames with pose / frames", f"{reg['frames_with_pose']} / {reg['frames']}"))
    facts.append(("mask kind used", _fmt(row.get("mask_kind"))))
    if frame:
        facts.append(("pose convention (in view, mask coverage)",
                      f"{frame['convention']} ({_fmt(frame['convention_in_view'])}, "
                      f"{_fmt(frame['convention_coverage'])})"))  # fmt: skip
        facts.append(("up source", frame["up_source"]))
        facts.append(("tilt gate exercised", _fmt(frame.get("tilt_gate_exercised"))))
        facts.append(("up vs camera-mean image-up deg", _fmt(frame["up_vs_camera_mean_deg"], 1)))
        facts.append(("intrinsics", _fmt(frame["intrinsics_source"])))
        facts.append(
            (
                "leg position (share of cloud on the leg)",
                f"{frame['leg_source']} ({_fmt(frame['leg_points_fraction'])})",
            )
        )
        facts.append(("leg point axis vs up deg", _fmt(frame["leg_axis_vs_up_deg"], 1)))
        if "joint_side" in frame:
            facts.append(("joint side", _fmt(frame["joint_side"])))
    if kf:
        facts.append(("keyframes used / candidates (blurry)",
                      f"{kf['used']} / {kf['candidates']} ({kf['blurry']})"))  # fmt: skip
        facts.append(("keyframe azimuth span deg", _fmt(kf["span_deg"], 1)))
    if masks:
        for k in MASK_KINDS:
            m = masks.get(k)
            if not m:
                continue
            facts.append((f"{k} masks: frames / median area / touching border / components",
                          f"{m['frames_with_mask']} / {masks['frames']} / "
                          f"{_fmt(m['median_area_fraction'])} / "
                          f"{_fmt(m['touching_border_fraction'])} / "
                          f"{_fmt(m['median_components'], 1)}"))  # fmt: skip
            if m["touching_side_fraction"]:
                facts.append((f"{k} masks touching each side",
                              _fmt(m["touching_side_fraction"], 2)))  # fmt: skip
        facts.append(("joints seen (frames)", _fmt(masks["joints_seen"])))
    if sil:
        facts.append(("silhouette version", _fmt(sil.get("silhouette_version"))))
        facts.append(("silhouette views used", str(sil["views_used"])))
        facts.append(("axis tilt deg", _fmt(sil["axis_tilt_deg"], 1)))
        facts.append(("view correction max deg", _fmt(sil["view_correction_max_deg"], 2)))
        facts.append(("joints used", str(sil["joints_used"])))
    if facts:
        lines += ["| fact | value |", "|---|---|"]
        lines += [f"| {k} | {v} |" for k, v in facts]
        lines.append("")
    metrics = row.get("metrics")
    if metrics:
        lines += [
            "| slice | OD/OW | OW/OW_S3 | OD/OD_S3 | nominal OW mm | nominal OD mm |",
            "|---|---|---|---|---|---|",
        ]
        for s in SLICES:
            d = metrics["slices"][s]
            lines.append(
                f"| {s} | {_fmt(d['OD/OW'])} | {_fmt(d['OW/OW_S3'])} | {_fmt(d['OD/OD_S3'])} "
                f"| {_fmt(d['nominal_OW_mm'], 1)} | {_fmt(d['nominal_OD_mm'], 1)} |"
            )
        lines += [
            "",
            f"Leg_Length/OW_S3: {_fmt(metrics['Leg_Length/OW_S3'])}",
            "",
            "Width profile, ankle to knee (diameter / max): "
            + ", ".join(_fmt(x, 2) for x in metrics.get("profile", [])),
            "",
        ]
        if row.get("gate_at_nominal_scale"):
            lines += [f"Gates at nominal scale: {row['gate_at_nominal_scale']}", ""]
    if row.get("estimator"):
        lines += _estimator_markdown(row["estimator"])
    return lines


def _action(action: dict | None) -> str:
    if not action:
        return "-"
    return f"tape {action['key']}" if action["kind"] == "tape" else str(action["kind"])


def _estimator_markdown(e: dict) -> list[str]:
    lines = [
        f"### {est.HEADING}",
        "",
        f"Provisional prior {_fmt(e.get('prior_version'))}, provisional noise and "
        "tolerances, source scale_free, no stature. Report only: it never changes the "
        "row's pass or fail. Every number is a ratio, a relative sigma (sigma / value) "
        "or r at the nominal scale; nothing here is a real size.",
        "",
    ]
    if e.get("status") != est.OK:
        return [*lines, f"Estimator failed ({_fmt(e.get('code'))}): {_fmt(e.get('reason'))}", ""]
    w = e["what_if_tape_Leg_Length"]
    lines += [
        "| fact | value |",
        "|---|---|",
        f"| verdict | {_fmt(e['verdict'])} |",
        f"| worst key | {_fmt(e['worst_key'])} |",
        f"| r (nominal scale) | {_fmt(e['r'], 2)} |",
        f"| best next action | {_action(e['best_action'])} |",
        f"| heights observed / observable | {e['heights_observed']} / {e['heights_observable']} |",
        "",
        "r after each candidate action (nominal scale): "
        + ", ".join(f"{k} {_fmt(v, 2)}" for k, v in e["r_after_action"].items()),
        "",
        "| ratio | raw | posterior | change |",
        "|---|---|---|---|",
    ]
    for k, v in e["posterior_ratios"].items():
        raw, change = e["raw_ratios"].get(k), e["ratio_change_from_raw"].get(k)
        lines.append(f"| {k} | {_fmt(raw)} | {_fmt(v)} | {_fmt(change)} |")
    lines += [
        "",
        "Hypothetical, not a measurement: one tape Leg_Length at the posterior mean "
        f"(nominal value) gives verdict {_fmt(w['verdict'])}, worst key "
        f"{_fmt(w['worst_key'])}, r {_fmt(w['r'], 2)} (nominal scale), best next action "
        f"{_action(w['best_action'])}.",
        "",
        "| key | relative sigma, posterior | relative sigma, hypothetical tape Leg_Length |",
        "|---|---|---|",
    ]
    for k, v in e["relative_sigma"].items():
        lines.append(f"| {k} | {_fmt(v)} | {_fmt(w['relative_sigma'].get(k))} |")
    lines.append("")
    return lines


def render_markdown(rows: Sequence[dict], pairs: Sequence[dict]) -> str:
    lines = [
        "# Video harness results",
        "",
        "Plain video has no scale: ratios lead. Values marked nominal are at a nominal "
        f"{NOMINAL_LEG_LENGTH_M * 1000:.0f} mm leg length, not real sizes.",
        "",
        "| video | status | stage | reason |",
        "|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r.get('video') or r.get('bundle')} | {r.get('status')} | "
            f"{_fmt(r.get('stage'))} | {_fmt(r.get('reason'))} |"
        )
    lines.append("")
    for r in rows:
        lines += _row_markdown(r)
    lines += ["## Agreement (assumed same leg)", ""]
    if not pairs:
        lines += ["Fewer than two successful videos; nothing to compare.", ""]
    else:
        keys = list(pairs[0]["diffs"])
        lines.append("| ratio | " + " | ".join(f"{p['a']} vs {p['b']}" for p in pairs) + " |")
        lines.append("|---|" + "---|" * len(pairs))
        for k in keys:
            lines.append(f"| {k} | " + " | ".join(_fmt(p["diffs"].get(k)) for p in pairs) + " |")
        lines.append("| max | " + " | ".join(
            f"{_fmt(p['max'])} ({p['max_key']})" for p in pairs) + " |")  # fmt: skip
        lines.append("")
    return "\n".join(lines)
