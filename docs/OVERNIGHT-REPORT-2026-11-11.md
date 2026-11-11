# Overnight report, 2026-11-11

Unattended session, 22:26 to 07:00 EST, branch `feat/overnight-2026-11-11`
(not merged to develop). Brief: docs/OVERNIGHT-2026-11-11.md. Updated after
every milestone, so the latest commit on the branch holds the latest state.

## Status at a glance

| Area | State |
|---|---|
| Video harness: Swift forms-video | done (bf48577) |
| Video harness: Python driver | done (9424e5c) |
| Iteration on the two test videos | round 2 in progress |
| Phase 1a estimator (pure, unwired) and shared contracts | done (5022b62, 6159a30, a81fca2) |
| Phase 2 3D viewer spike (r3f + expo-gl) | in progress |
| Admin product management | round 1 in progress (catalog depth, photos; migrations 0022, 0023) |
| UI and UX pass | not started |
| docs/BUSINESS-GAPS.md | done (5ad999e) |

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

- Shared contracts (6159a30): forms.leg-model v1 and
  forms.measurement-quality v1, TS and Python validators, 67 shared fixtures
  that pass or fail identically on both sides.
- Leg estimator v1, Phase 1a (a81fca2): forms_pipeline/shape, pure and
  unwired. 206 tests, including a calibration check (2-sigma coverage 0.947
  over 200 seeded synthetic legs). Its output validates in the TS validator.
  Provisional feasibility table (placeholder noise and tolerances, not a ship
  check):

  | Source mix | Verdict | r | Worst key |
  |---|---|---|---|
  | Full silhouette sweep (span 180) | required | 1.01 | Leg_Length |
  | Short sweep (span 90) | required | 1.57 | S2_OD |
  | Mesh | required | 1.21 | Leg_Length |
  | Manual only | none | 0.00 | none |
  | Prior only | fail | 18.79 | S3_OD |

  Plan 4.6 requires a full sweep to come out "none". Leg_Length binds: 5 mm
  landmark sigma plus the per-capture scale term gives 7.6 mm against a
  15 mm tolerance. Widths and depths pass (r up to 0.95). Per the plan the
  tolerance or the capture changes, not the bands: a decision for Liam and
  Zane after the Phase 0 calibration.

- Business gaps audit (5ad999e): 20 areas ranked by launch impact. The
  blockers (tax, shipping, policies, checkout completion, fulfillment) all
  need Liam's accounts, money or legal text; it started in parallel with the
  scan agents because it was read-only and took nothing from them.

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

Round 1 (d39e5f1 silhouette, 83e1efb harness):

- Loft fix: rings no longer twist half or quarter turns between heights
  (a slice in a twisted band read 0.2% of the true section area).
- Cut-off framing no longer fails the scan; only border edges are dropped,
  and when too little remains the reason names the missing part. Synthetic
  legs cropped by an exact camera model recover within 2%.
- Harness: up for an upside-down phone (floor of either sign, else the leg
  axis signed by the narrow ankle end).
- Result at 60 frames: IMG_3834 "The knee was outside the frame in most of
  the photos" (10 of 15 views run off at the knee end; the 5 that see it
  span 36 deg). IMG_3836 fails the 120 deg span gate at 103 deg because
  photogrammetry registered only frames 0 to 37.

Denser sampling (forms-video --max-frames 120): registration goes from 44/60
to 119/120 (IMG_3834) and 38/60 to 103/103 (IMG_3836); spans 214 and 173
deg. The unregistered stretches were the knee close-ups. New failures, under
investigation in round 2: IMG_3834 "Keep your shin upright" (axis 43 deg
from a floor plane that is probably the wrong plane), IMG_3836 "The ankle was
outside the frame".

## Untested on a device

Nothing from this session has run on a phone. Everything below that touches
capture is Mac-side only.

## TODO(liam) defaults taken

- **Phase 1 migrations deferred (against the brief).** forms-architect
  reviewed the Phase 1 brief and recommended 0018, 0019 and 0021 wait for
  Phase 1b (wiring after the Phase 0 ground truth): a quality table and a
  leg-models table with no writer are dead schema; 0021's refusion RPC is a
  client-callable SECURITY DEFINER function with no caller and a "refuse when
  adjusted" rule SQL cannot express yet (adjusted and manual share
  source 'manual'); the order snapshot changes the Stripe paid transition,
  which should not change unattended. The numbers stay reserved. Tonight
  ships the pure estimator and the two contracts (docs/ESTIMATOR-V1.md).
- Estimator noise levels, the bootstrap prior and the gate tolerances (15 mm
  Leg_Length, 6 mm fit-critical OW and OD) are provisional placeholders,
  flagged `provisional` in the files, until the Phase 0 calibration.
- Estimator conservative defaults: manual input accepts any non-empty subset
  of the 9 typed keys; a missing or invalid tolerance makes the gate fail,
  never pass; keys already typed are not offered as tape actions.

## Onshape copies created

None.

## What failed and why

Nothing yet.

## Next steps

To be written at the end of the session.
