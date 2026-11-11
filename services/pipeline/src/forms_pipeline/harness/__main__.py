"""python -m forms_pipeline.harness run|analyze (docs/VIDEO-HARNESS.md)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from forms_pipeline.harness.bundle import MASK_KINDS, MAX_FRAMES
from forms_pipeline.harness.keyframes import DEFAULT_MAX_KEYFRAMES
from forms_pipeline.harness.run import (
    DEFAULT_BUNDLES,
    DEFAULT_FORMS_VIDEO,
    DEFAULT_OUT,
    DEFAULT_VIDEOS,
    FORMS_VIDEO_MAX_FRAMES,
    FORMS_VIDEO_TIMEOUT_S,
    MIN_FORMS_VIDEO_FRAMES,
    Options,
    analyze_bundle,
    render_markdown,
    run_videos,
)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m forms_pipeline.harness")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--out", type=Path, default=DEFAULT_OUT)
        p.add_argument("--max-keyframes", type=int, default=DEFAULT_MAX_KEYFRAMES)
        p.add_argument("--mask", choices=MASK_KINDS, default=Options().mask_kind)

    run = sub.add_parser("run", help="every video: forms-video, then analyze")
    run.add_argument("--videos", type=Path, default=DEFAULT_VIDEOS)
    run.add_argument("--bundles", type=Path, default=DEFAULT_BUNDLES)
    run.add_argument("--forms-video", type=Path, default=DEFAULT_FORMS_VIDEO)
    run.add_argument("--reuse", action="store_true", help="skip forms-video if the bundle exists")
    run.add_argument("--timeout-s", type=float, default=FORMS_VIDEO_TIMEOUT_S)
    run.add_argument(
        "--max-frames",
        type=int,
        default=FORMS_VIDEO_MAX_FRAMES,
        help="frames forms-video samples per video",
    )
    common(run)

    analyze = sub.add_parser("analyze", help="one existing bundle")
    analyze.add_argument("--bundle", type=Path, required=True)
    common(analyze)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        options = Options(max_keyframes=args.max_keyframes, mask_kind=args.mask)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    if args.command == "run":
        if not MIN_FORMS_VIDEO_FRAMES <= args.max_frames <= MAX_FRAMES:
            print(
                f"--max-frames must be between {MIN_FORMS_VIDEO_FRAMES} and {MAX_FRAMES}",
                file=sys.stderr,
            )
            return 2
        if not args.videos.is_dir():
            print("videos directory not found", file=sys.stderr)
            return 2
        rows = run_videos(
            args.videos.resolve(),
            args.out.resolve(),
            bundles_dir=args.bundles.resolve(),
            tool=args.forms_video,
            reuse=args.reuse,
            options=options,
            timeout_s=args.timeout_s,
            max_frames=args.max_frames,
        )
        ok = sum(r.get("status") == "ok" for r in rows)
        print(f"{ok} of {len(rows)} videos analyzed; see {args.out / 'results.md'}")
        return 0
    row = analyze_bundle(args.bundle, args.out.resolve(), options)
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{row['bundle']}.json").write_text(json.dumps(row, indent=2) + "\n", encoding="utf-8")
    print(render_markdown([row], []))
    return 0


if __name__ == "__main__":
    sys.exit(main())
