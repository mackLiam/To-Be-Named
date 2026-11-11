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

```
# once: build the Swift CLI (macOS 26+ for estimated intrinsics)
cd services/reconstruct && swift build -c release

# every video in services/pipeline/recordings/videos -> bundles -> results
cd services/pipeline
.venv/bin/python -m forms_pipeline.harness run            # builds bundles, then analyzes
.venv/bin/python -m forms_pipeline.harness run --reuse    # reuse existing bundles
.venv/bin/python -m forms_pipeline.harness run --max-frames 60 --bundles recordings/bundles60
.venv/bin/python -m forms_pipeline.harness run --mask person
.venv/bin/python -m forms_pipeline.harness analyze --bundle recordings/bundles/IMG_3834
```

Defaults: videos from `recordings/videos/`, bundles to `recordings/bundles/<stem>/`,
results to `recordings/harness/results.md` and `results.json`, 120 sampled
frames, the foreground-instance mask, at most 24 keyframes. A run takes about
a minute per video on an M3 Max. One video failing never stops the run;
every failure is a row with its stage and the production reason string.

What the harness does to a bundle, in order:

1. Resolve the pose convention against the point cloud and the masks
   (RealityKit poses are camera-to-world with ARKit axes; the resolver
   still checks all four candidates).
2. Find up: the floor plane among points outside the leg masks, ranked by
   the area its inliers cover (not their count), which must support the leg
   (almost no leg points below it, cameras on the knee side, the leg's low
   end near it). Fallback: the mask-triangulated leg axis, signed away from
   the foot by a vote across views (the narrowest band of each mask is the
   ankle). Rows record `up_source` and whether the tilt gate was exercised.
3. Rescale so the cameras sit a nominal 0.40 m from the leg; pick keyframes
   by azimuth (6 degree spacing, sharpest per bin), as the phone will
   (SCAN-V3-PLAN.md 5.2).
4. Run the production `reconstruct_silhouette` twice: once at the nominal
   camera scale, then again with the world rescaled to a nominal 400 mm leg
   so its metric thresholds act at a realistic size. Measure exactly as the
   measuring step does.
5. Report ratios: OD/OW per slice, widths relative to S3, Leg_Length/OW_S3,
   a 21-point width profile, plus mask and registration quality and
   agreement between videos (assumed to be the same leg).

## What each video taught

Two iPhone Camera app videos of one adult leg (with consent), 720x1280 HEVC,
no metadata, recorded badly on purpose. Counts and ratios only.

| | IMG_3834 | IMG_3836 |
|---|---|---|
| Recording | upright phone, close up, seated, knee bent about 90 deg | phone upside down, close up, foot pointed along the shin |
| Registered frames at 60 / 120 sampled | 44 / 60, 119 / 120 | 38 / 60, 103 / 103 |
| Keyframe span at 120 | 200 deg | 173 deg |
| Up source | floor plane (shin 18 deg from vertical) | leg axis (no floor found) |
| Baseline result (production math, 9424e5c) | fail: cut off at the edge of a keyframe | fail: cut off at the edge of a keyframe |
| Result at silhouette v3 (8ebbd81) | **measured** | fail: "The knee was outside the frame in most of the photos" |
| Final result (silhouette v4, b9d9b15) | retake: "The knee was bent too far to measure; sit with your foot further forward so the leg is straighter." | fail: "The knee was outside the frame in most of the photos" |

IMG_3834, scale-free ratios at 120 frames (silhouette v3, before the bent-knee rule):

| slice | OD/OW | OW/OW_S3 | OD/OD_S3 |
|---|---|---|---|
| S1 | 0.882 | 0.688 | 0.654 |
| S2 | 0.913 | 0.871 | 0.858 |
| S3 | 0.927 | 1.000 | 1.000 |
| S4 | 0.957 | 0.963 | 0.994 |

Leg_Length/OW_S3 = 2.62. Width profile ankle to knee (diameter / max): 0.58
0.59 0.61 0.64 0.67 0.71 0.75 0.79 0.85 0.90 0.93 0.99 0.99 0.99 1.00 0.99
0.98 0.98 0.92 0.80 0.76.

**IMG_3834.** Close-up framing ran the thigh off one side of every frame,
and before silhouette v2 any such view failed the scan. Dropping only the
border edges kept a clean profile from the foot to the calf. At 60 sampled
frames photogrammetry lost the knee close-ups (frames 26 to 40), so only 5
views over 36 degrees saw the knee: an honest "knee outside the frame". At
120 frames everything registered, and the denser cloud exposed a harness
defect: a compact clump beside the foot outvoted the real floor on point
count. Ranking planes by covered area fixed it; floor plane, leg points and
mask axis then agree on an 18 degree shin. The first real video to reach
measurement: OD/OW 0.88 to 0.96 and the profile shape are human.
Leg_Length/OW_S3 = 2.62 reads short (an adult is typically above 3).

**Bent knee (silhouette v4, b9d9b15).** On a synthetic hinged leg
(tests/bent_knee_synth.py) the thigh enters slices perpendicular to the shin
before the dip below the kneecap once the knee bends past about 45 degrees.
Leg_Length was -1.0% at 45, -2.9% at 60, -5.9% at 75 and -14.6% at 90
degrees, and the photogrammetry sections behave the same. The dip is hidden
there, so a knee within one extremum window of the thigh onset (width
growing faster than 0.8 per unit of shin length) is not accepted, and the
capture is a retake asking for a straighter leg. IMG_3834 now fails that
way. Its old knee sat on a flat stretch exactly one window below the onset,
so the bend explains at most about 5% of its short ratio; the rest (likely a
generous mask edge at close range widening OW_S3, or a stocky leg) is
unexplained until tape ground truth exists. The harness therefore has no
measured real video at v4.

**Typed Leg_Length (e43035b, unwired).** `reconstruct_silhouette` takes an
optional `leg_length_m` (the user's tape value, converted from mm by the
caller). The scan then finds only the ankle and cuts at ankle plus the
typed length. The thigh may enter above S4 (80% of the length) but not
below it, which stays a bent-knee retake. Above the thigh onset the mesh
repeats the last section below the thigh. On the hinged synthetic leg the
thigh onset is at 105%, 100%, 96% and 87% of leg length at 45, 60, 75 and 90
degrees, and with the true length typed every S1..S4 OW and OD is within
0.7% of the straight leg at all of them, where the landmark rule retakes
from 60 degrees. A seated pose is measurable once a tape value is supplied.
Untested on a real capture.

**IMG_3836.** The upside-down phone made camera image-up point 163 degrees
away from the leg's up, so "up" must come from the scene (floor) or the leg
itself, never from how the phone was held. The pointed foot ran its toes off
the frame, which is harmless; the knee end ran off the frame in 15 of 18
keyframes with the profile still widening at the cut, which is fatal. The
truncated profile also shrank the ankle search window below an ankle that
was in view, so the scan first blamed the ankle; v3 names the knee. At 60
frames photogrammetry also dropped the last third of the sweep (103 degree
arc), a silent shortening that dense sampling removed.

**Across both.** Every failure that remains is framing, not math: the knee
end must be in view, with a little thigh above it, across the arc. Vision
body pose found no body in any close-up frame (0 of 223), so knee and ankle
must come from the width profile on this footage. The foreground-instance
mask isolates the leg cleanly (one component per frame); person
segmentation fragments into 70 to 100 components and is not usable here.

## Scale

Nothing here has a real size. The harness now runs the leg estimator as a
report-only stage on every measured row (5e1ffb3): the mesh becomes a
`scale_free` source, fused with prior 0.1.0 and gated with the provisional
tolerances, under "Estimator (provisional prior, report only)" in
results.md. It never changes a row's pass or fail.

On IMG_3834 at silhouette v3 (run with the bent-knee rule disabled in
memory, as a diagnostic) the gate says fail (r 15.5, about 32% relative
sigma on every key: size comes only from the prior) and asks for a tape
Leg_Length. With that one hypothetical tape, r falls to 1.12, which is
still "required", and the gate next asks for a depth (S4_OD); the synthetic
bundle behaves the same (r 1.07, then S3_OD). So under the provisional noise
and 6 mm tolerances a scale-free capture needs **Leg_Length plus one
depth**, not one number. Posterior ratios move little on synthetic legs
(0.011 at most) and more on IMG_3834 (S4 OD/OW +0.058, Leg_Length/OW_S3
-0.082). All of this is provisional until calibration.
