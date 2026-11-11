# Video harness (local, Mac only)

A local tool that runs plain iPhone videos of a leg through the scan math and
writes a results table, so capture and reconstruction changes can be judged
on bad, real-world input without a phone build. Written 2026-11-11 during the
overnight session (docs/OVERNIGHT-2026-11-11.md). It never uploads anything.

Videos are body data. They live in `services/pipeline/recordings/videos/`
(gitignored, as is everything under `recordings/`). Nothing derived from them
is committed; this document records counts and ratios only.

## Pieces

```
 video.MOV
    |  forms-video (Swift, services/reconstruct, macOS 26+)
    v
 bundle dir: video.json, frames/NNN.jpg, masks/<kind>/NNN.png, points.f32, model.obj
    |  python -m forms_pipeline.harness (services/pipeline)
    v
 normalize frame (floor plane -> up, nominal scale) -> azimuth keyframes
    -> reconstruct_silhouette (production math) -> extraction -> scale-free metrics
    v
 results.json + results.md (per video, plus agreement between videos)
```

Plain video has no ARKit poses, depth or scale (SCAN-V3-PLAN.md section 5.7).
PhotogrammetrySession supplies camera poses and, on macOS 26+, estimated
per-sample intrinsics; the floor plane in its point cloud supplies "up". Scale
stays unknown, so every reported number is a ratio.

## Contract: forms.video-bundle v1 (pinned; Swift writes, Python validates)

Directory layout written by `forms-video --video <file> --out <dir>`:

```
<dir>/video.json                 manifest below (UTF-8 JSON, at most 4 MiB)
<dir>/frames/NNN.jpg             selected frames, NNN = id zero-padded to 3 digits
<dir>/masks/person/NNN.png       8-bit grayscale, values 0 or 255, frame size
<dir>/masks/foreground/NNN.png   same format; absent when that request failed
<dir>/points.f32                 photogrammetry point cloud, float32 little-endian x,y,z
                                 triples, session units; absent if not produced
<dir>/model.obj                  geometry-only OBJ (v and f lines); absent if not produced
```

Pixels are those of the written JPEG (the decoded frame with the track's
preferredTransform applied, so the image is upright as recorded). u is the
column (grows right), v is the row (grows down).

```json
{
  "format": "forms.video-bundle",
  "version": 1,
  "source": {
    "duration_s": 17.4,
    "fps": 30.0,
    "width": 720,
    "height": 1280,
    "frames_decoded": 522
  },
  "tool": { "name": "forms-video", "seconds": 95.2, "max_frames": 60 },
  "photogrammetry": {
    "status": "ok",
    "error": null,
    "submitted": 60,
    "registered": 41,
    "points": 18234,
    "model": true,
    "convention": "realitykit_pose"
  },
  "frames": [
    {
      "id": 0,
      "file": "frames/000.jpg",
      "time_s": 0.133,
      "width": 720,
      "height": 1280,
      "sharpness": 152.7,
      "motion_px": 4.1,
      "masks": {
        "person": { "file": "masks/person/000.png", "area_fraction": 0.31 },
        "foreground": { "file": "masks/foreground/000.png", "area_fraction": 0.28, "instances": 2 }
      },
      "joints": {
        "right_knee": [402.5, 233.0, 0.82],
        "right_ankle": [388.1, 1011.4, 0.64]
      },
      "pose": {
        "transform": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        "intrinsics": [880, 0, 0, 0, 880, 0, 360, 640, 1]
      }
    }
  ]
}
```

Field rules:

- `photogrammetry.status` is one of `ok`, `failed`, `skipped`. On `failed`,
  `error` is a short fixed kind string (`no_poses`, `session_init`,
  `process`, `timeout`, `unsupported`), never a path or framework text, and
  every frame's `pose` is null.
- `masks.person` / `masks.foreground` are null when that Vision request
  failed for the frame. `foreground` uses the instance(s) overlapping the
  person mask most (all instances when there is no person mask);
  `instances` is the count Vision returned.
- `sharpness`: variance of a 3x3 Laplacian on the grayscale frame downscaled
  so its long side is at most 360 px. `motion_px`: global translation to the
  previous decoded frame in written pixels (null for the first decoded frame).
- `joints`: Vision body-pose joints with confidence above 0.1, keys from
  `left_knee`, `right_knee`, `left_ankle`, `right_ankle`, `left_hip`,
  `right_hip`, each `[u, v, confidence]` in written pixels. Missing keys mean
  not detected.
- `pose` is null when PhotogrammetrySession did not register the frame.
  `transform` is `PhotogrammetrySession.Pose.transform.matrix`, column-major,
  exactly as RealityKit holds it (no convention change in Swift).
  `intrinsics` is `Pose.intrinsics` (3x3, column-major) or null when the OS
  does not provide it. Python resolves the conventions against the point
  cloud and the masks; Swift never guesses.
- Caps (Python rejects a bundle beyond them): at most 200 frames, frame side
  at most 4096 px, `points` at most 2,000,000, every file name matching the
  patterns above, every path inside the bundle directory.

## How to run

TODO: filled in when the harness lands.

## What each video taught

TODO: filled in from the results tables (counts and ratios only).
