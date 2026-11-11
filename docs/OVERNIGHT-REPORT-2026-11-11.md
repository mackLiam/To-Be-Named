# Overnight report, 2026-11-11

Unattended session, 22:26 to 07:00 EST, branch `feat/overnight-2026-11-11`
(not merged to develop). Brief: docs/OVERNIGHT-2026-11-11.md. Updated after
every milestone, so the latest commit on the branch holds the latest state.

## Status at a glance

| Area | State |
|---|---|
| Video harness: Swift forms-video | done (bf48577) |
| Video harness: Python driver | done (9424e5c) |
| Iteration on the two test videos | in progress |
| Phase 1 estimator | brief under forms-architect review |
| Admin product management | not started |
| UI and UX pass | not started |
| docs/BUSINESS-GAPS.md | not started |

## Done (with commits)

- Contract for the harness bundle (forms.video-bundle v1) written into
  docs/VIDEO-HARNESS.md before either side was built.
- SCAN-V3-PLAN.md section 5.7: one tape measurement per leg adds real scale
  (2d15b35).
- fitPreview.ts Club coverage 0.12-0.88 corrected to the model's 0.2-0.8
  (5054ca1).
- forms-video Swift CLI (bf48577): frames, sharpness, Vision masks and
  joints, PhotogrammetrySession poses, intrinsics and point cloud. 23 XCTest
  cases. First findings on the two videos:
  - Photogrammetry registered 44 of 60 frames (IMG_3834) and 38 of 60
    (IMG_3836). The unregistered frames are exactly the bad stretches (too
    close to the knee; the end of the upside-down sweep).
  - Poses are camera-to-world with ARKit axes; macOS 26+ returns one
    estimated intrinsics matrix per session.
  - Vision body pose finds no body in close-up leg footage (0 of 120
    frames), so knee and ankle must come from the width profile, never from
    joints alone.
  - The foreground-instance mask isolates the leg better than person
    segmentation (median area 0.46 / 0.39 of the frame vs 0.61 / 0.45).

- Python harness (9424e5c): `python -m forms_pipeline.harness run`.
  Resolves the pose convention from the data, finds up from the floor
  plane, picks keyframes by azimuth, runs the production silhouette math
  unchanged, and reports ratios only. 94 tests on synthetic legs under random
  similarity transforms. It found a production bug: the silhouette loft can
  join neighbouring rings half a turn apart (eigenvector sign flip), which
  corrupts any slice that lands in that band. Fix in progress.

## Video results (counts and ratios only)

Baseline, production math unchanged (9424e5c):

| | IMG_3834 | IMG_3836 |
|---|---|---|
| Result | fail: silhouette pass 1 | fail: silhouette pass 1 |
| Reason | leg cut off at the edge of a keyframe | leg cut off at the edge of a keyframe |
| Registered / submitted frames | 44 / 60 | 38 / 60 |
| Keyframes used / candidates | 16 / 44 | 10 / 38 |
| Azimuth span | 159 deg | 95 deg (gate is 120) |
| Up source | floor plane | camera fallback (phone upside down) |
| Leg axis vs up | 18 deg | 34 deg (gate is 30) |
| Foreground masks touching a border | 100% | 98% |
| Body-pose joints found | 0 frames | 0 frames |

Both fail at the first gate because close-up footage runs the thigh or foot
off the frame in almost every frame, and today any cut-off view fails the
whole scan.

## Untested on a device

Nothing from this session has run on a phone. Everything below that touches
capture is Mac-side only.

## TODO(liam) defaults taken

None yet.

## Onshape copies created

None.

## What failed and why

Nothing yet.

## Next steps

To be written at the end of the session.
