# Scan plan: a solo, non-LiDAR leg scan that works

Written 2026-09-30 after the first real-device tests. This document is the
working plan for capture quality; architecture truth stays in DESIGN.md, and
the decisions here move into DESIGN.md as each one ships.

---

## 1. What "done" means (Liam's words are the acceptance criteria)

1. "It needs to work with just yourself": one person, scanning their own leg.
2. Any iPhone, including ones without LiDAR (the test phone is an iPhone 16).
3. "I know the lighting isn't the best ... still": ordinary indoor light must work.
4. "Better error messaging": the app always says what is wrong and how to fix it.
5. "If the scan isn't working ... enter manually", with "a diagram of where to
   measure", and manual "for adjustment ... to check after".
6. "Use what I can so we aren't making everything new" and "it needs to work in
   a prod environment".
7. Implied by the product: measurements accurate enough to print a guard that
   fits. Targets: Leg_Length within 2%, widths and depths within 3-5% of a tape
   measure (ROADMAP week 3 targets), on 10 real legs.

---

## 2. What the device tests proved (evidence, not guesses)

| Test | Result | What it means |
|---|---|---|
| iPhone 16, Apple Object Capture | `isSupported == false`, reason "device" | Apple's 3D capture needs LiDAR. Hardware limit. |
| v1 photo sweep, solo | Never finished; coverage under 30% | Done required 70% around; you cannot circle your own shin. |
| v2 sweep with live stats, solo, 2 tries | 64 photos, coverage stuck at 19-44%, 800+ "too close", 260 "blurry" | Even with guidance, a steady arc around your own leg is not physically practical. |
| v2 aim tap | First tap placed the leg at the phone (distance read 4 cm) | Non-LiDAR raycasts hit false planes near the camera. Fixed: median depth of tracked points in a narrow cone. |
| Save | Zero upload requests reached the server | Something fails between finishing and uploading; dev logging added to pin it. |
| Worker | One DB timeout killed the worker thread while health stayed green | Fixed (7322027): capped backoff, never dies. |
| Full server path, replayed 60-photo leg | Upload with RLS, queue, Mac reconstruction, measure: Leg_Length 365.5 vs 370 mm (1.2%), S2_OW 108.3 vs about 108.3 mm, about 70 s | Everything after the photos works. The problem is purely solo capture. |

Conclusion: the 3D sweep stays for people with a helper, but the solo path must
not depend on circling the leg.

---

## 3. The YOLO question, answered

Liam's earlier project (github.com/mackLiam/Vision-obstacle-detection, Best
Overall at UWindsor Demo Day 2026) was evaluated file by file:

- Its YOLO part is YOLOv8 bounding-box detection on COCO (`src/detector.py`,
  `src/tracker.py`); no segmentation, no pose.
- Its 3D part is Open3D TSDF fusion of depth frames from the Record3D app
  (`src/live_generator.py`). That depth comes from LiDAR or TrueDepth. It did
  not reconstruct 3D from plain photos.
- Ultralytics YOLO and its weights are AGPL-3.0. Shipping them in the iOS app
  (Core ML export included) would oblige publishing the app's source; running a
  modified copy behind our API triggers AGPL section 13. The commercial route is
  an Ultralytics Enterprise license, a recurring cost.

Decision: do not add Ultralytics. The jobs YOLO would do are covered on the
phone, free and private, by Apple Vision:

| Job | YOLO option | What we use instead | Why |
|---|---|---|---|
| Cut the leg out of the photo | YOLOv8/11-seg "person" mask | `VNGenerateForegroundInstanceMaskRequest` (iOS 17+) | Sharper subject edges, no license, never leaves the phone. Edge quality is the whole measurement. |
| Find knee and ankle | YOLO pose keypoints | `VNDetectHumanBodyPoseRequest` (knee, ankle joints with confidence) | Same capability, on device, free. Used to seed landmarks, not as the final cut. |
| Metric depth without LiDAR | Monocular depth models | ARKit visual-inertial poses | Monocular metric depth is 5-10% off; ARKit scale is 1-2%. Depth Anything V2 Base/Large are non-commercial anyway. |

Reused from the project: its device-proven ARKit-to-OpenCV camera conversion
(`c2w_cv = c2w_arkit @ diag(1, -1, -1, 1)`) is now the cross-check test for the
server's projection math.

---

## 4. Capture tiers (each user lands on the best one their situation allows)

| Tier | Who | How | Server | Status |
|---|---|---|---|---|
| T1 | LiDAR iPhone, helper | Apple Object Capture, on-device mesh | measure only | built, not yet tried on a LiDAR phone |
| T2 | Any iPhone, helper | v2 guided 3D photo sweep (aim, checklist, coverage ring) | Mac photogrammetry, ARKit scale alignment | built (802585e, 80f840d) |
| T3 | Any iPhone, alone (primary) | 5-station silhouette photos | shape from silhouette, any worker | in progress |
| T4 | Anyone, any time | Manual tape-and-books entry with diagrams, or adjust a scan | worker re-validates | built (31c1579, db5f013) |

Routing: the capture screen asks "Is someone helping you?". Alone means T3 on
every iPhone. With a helper, T1 on LiDAR phones and T2 otherwise. T4 is offered
on every failure screen and after 20 seconds stuck at a station.

---

## 5. T3 in depth: 5-station silhouette capture

### 5.1 Why it works alone
All five stations sit in the front half circle: front, 45 degrees to each side,
and 90 degrees to each side. Each one is a still photo taken where a seated
person can easily hold the phone. Nothing requires reaching behind the leg.
Stills taken while holding steady are far less blurry than frames from a moving
sweep.

### 5.2 Protocol (what the user does)
1. Sit on a chair, foot flat, shin upright, shorts or trousers above the knee,
   the other leg moved away.
2. Point the phone at the floor for a moment (floor detection), then at the shin
   and tap (aim; the leg axis appears in AR).
3. The mini map shows five dots. Move to each dot. When the checklist is all
   green for half a second, the photo takes itself (flash and haptic).
4. After five (or four: the front plus one each side), Done. Retake any dot.

### 5.3 On-device checks (the live checklist, one row each)
| Row | Condition | Message when failing |
|---|---|---|
| Right spot | azimuth within 12 degrees of the station | "Move to the next dot" plus an arrow |
| Distance | 0.30 to 0.80 m from the leg axis | "Move closer" / "Move back" |
| Level | optical axis within 25 degrees of horizontal | tilt indicator, "Lower the phone and hold it level" |
| Still | angular speed under 0.3 rad/s for 0.5 s, Laplacian sharpness above threshold | "Hold steady a moment" |
| Whole leg in view | mask found at the aimed point, not touching the side edges, at least 45% of the image height | "Leg cut off at the side" / "Show from the floor to above the knee" / "Can't see your leg clearly, add light or move the other leg away" |

Light: if ambient light is under 400 or the mask fails 3 times in a row while
everything else is green, the app shows "It's a bit dark here" with a one-tap
torch (the iPhone flashlight stays on during the ARKit session, level 0.6). The
torch toggle is always on screen.

Stuck for 20 s at a station: a "Having trouble?" sheet names the condition that
failed most often and its fix, with "Start over" and "Enter measurements by hand".

### 5.4 What the phone sends (capture.json v2)
Per station: JPEG (sensor orientation, at most 2048 px), an 8-bit leg mask PNG at
the same size, the ARKit camera pose (metric, gravity aligned), the intrinsics,
the station name, and optional knee and ankle joints from Vision body pose.
Plus the aim anchor, the floor height, mode and coverage. No video, no depth,
nothing uploaded until the user taps Done. Contract pinned in the agent briefs
and mirrored by validators on both sides.

### 5.5 Server math (forms_pipeline/reconstruct/silhouette.py)
1. Masks: binarize, keep the largest connected component.
2. Leg axis: each view's mask centerline back-projects to a plane through its
   camera, and the 3D axis line is the least-squares intersection of those
   planes. Tilt up to 30 degrees is allowed, so a seated shin does not have to
   be perfectly vertical.
3. Cross-sections every 2 mm along the axis: in every view, the left and right
   mask edges at that height each define a plane tangent to the leg. Each
   tangent plane cuts the cross-section plane in a line. Five views give ten
   tangent lines, and an ellipse (5 parameters) is fitted to all of them through
   the dual conic (linear least squares by SVD), with one outlier rejection pass.
4. Smoothing along the axis: median, then a short moving average. Heights with
   fewer than 3 good views are dropped.
5. Landmarks: knee and ankle are triangulated from the Vision joints when their
   confidence is at least 0.5. They seed search windows of plus or minus 40 mm,
   and the width-profile rule shared with the photogrammetry path makes the
   final cut (ankle at the narrowest point above the foot, knee at the dip below
   the kneecap), so both tiers measure the same anatomy.
6. Output: a closed mesh lofted from the ellipses, in mm. The existing
   measuring step reads it unchanged, so fit preview, CAD and Onshape need no
   changes.
7. Quality gates, each a "please retake" with a reason:
   - fewer than 3 usable views
   - view span under 120 degrees
   - leg cut off in a view
   - shin tilted over 30 degrees
   - large residuals in the ellipse fit
   - knee or ankle not found

### 5.6 Accuracy budget (why 3-5% is reachable)
| Error source | Size at about 0.5 m | Effect on a 100 mm width | Mitigation |
|---|---|---|---|
| ARKit scale drift | 1-2% | 1-2 mm | short capture, stations close together in time |
| Mask edge | about 2 px at fx 1450 | about 0.7 mm per edge | Vision subject mask, light and torch, contrast tips |
| Pose jitter | about 5 mm / 1 degree | under 1 mm after the fit over 10 lines | least squares plus outlier rejection |
| Shape model | real sections are not ellipses (the flat inner face of the tibia) | up to 2-3% on ISW/ICW | outer OW/OD come straight from the tangents; next step is a 7-parameter shape once 5 views prove stable |
| Clothing and posture | sock or trouser edges | varies | instructions, mask checks, tilt gate |

Synthetic targets in CI: within 2% clean, within 5% with noise added.

### 5.7 What 5 views cannot see
The back of the calf is inferred from the ellipse, not observed. OW (side to
side) is measured directly. OD (front to back) comes from the 45 and 90 degree
views, which see the depth profile edge-on, so it is well determined. The
medial/lateral split (ISW vs ICW) is the weakest number on every tier, and its
geometric meaning inside Zane's model is still open (DESIGN.md section 12.2).
That walkthrough decides how much effort the split deserves.

---

## 6. Error messaging principles (all tiers)

1. One primary instruction, always visible, in plain words.
2. A checklist that shows which condition is blocking, never a silent wait.
3. Every failure names the fix ("Turn on more light", "Move closer"), not a code.
4. Never a dead end. Always visible:
   - Finish anyway (T2)
   - Finish with 4 (T3)
   - Enter by hand (T4)
5. Server failures come back to the scan screen with the step and the reason:
   - failed_step (0013) says whether reconstruction or measuring failed
   - the gate reason says what to change on the retake
6. Dev builds stream counters (never images or poses) to the Metro log, so every
   real attempt tunes the thresholds.

---

## 7. Production setup

| Concern | Plan |
|---|---|
| Where T3 runs | Any worker, as pure numpy. A Linux container next to the measure worker. Seconds per scan. |
| Where T2 runs | macOS only (PhotogrammetrySession). A Mac mini worker started with `WORKER_STEPS=reconstructing` (DESIGN.md section 10a: buy, don't rent). Scale it by adding Macs. |
| Queue | Postgres queue, claim filtered by step (0008), backoff, dead letter, scan status driven by trigger (0013). Workers survive DB outages (7322027). |
| Storage | Private meshes bucket under the owner's prefix, upsert retries, retention deletes photo bundles and masks (0015). |
| Privacy | Masks and joints computed on device. Body photos uploaded only on Done, under RLS, and deleted by retention. Minors: stricter retention to be confirmed with legal. |
| Observability | Sentry for exceptions. PostHog events with counts only: capture_started, station_captured, capture_failed{condition}, upload_failed{code}, reconstruct_failed{gate}. No body data. |
| Rollout | Ship T3 behind a remote flag. Run T3 and T4 side by side on the first 10 real legs. Make T3 the solo default only when the accuracy log meets section 1, item 7. |
| Regression | Each consented real capture is recorded with forms-replay as a golden fixture (gitignored body data, kept outside the repo); CI runs synthetic suites and the replay set runs before a release. |
| Onshape | Unchanged: CAD only on a paid order (0008 trigger), on a per-job copy of the template, never the original. |

---

## 8. Validation plan

1. Synthetic, in CI: rendered legs (tapered, calf bulge, tilted 0/10/20 degrees,
   rotated ellipses) from the 5 stations, clean and noisy. Targets as in 5.6.
2. Replay: every real attempt is recorded and re-run after each algorithm change,
   with a diff table against the previous run.
3. Tape-measure ground truth: 10 legs (family and friends, consent noted), marked
   at 20/40/60/80%, measured with the two-book method, and logged in
   docs/accuracy-log.md with EXTRACTION_VERSION.
4. Ship criterion: at least 8 of 10 legs within targets, and none worse than 8%
   on any OW/OD.

---

## 9. Workstreams and status

| # | Work | Status |
|---|---|---|
| 1 | Photo capture v1 and v2 (aim, checklist, solo/helper, stats) | committed (e541e9f, 802585e); aim fix pending commit |
| 2 | Reconstruction worker, anchor axis, partial arcs | committed (0a26328, 80f840d) |
| 3 | Manual and adjust measurements, diagrams | committed (db5f013, 31c1579, 2905358) |
| 4 | Replay tool | committed (c09ccc1) |
| 5 | T3 server: silhouette math, v2 bundle, joints | in progress |
| 6 | T3 iOS: stations, masks, joints, checklist, torch, trouble sheet, dev flow logging | in progress |
| 7 | Find the "won't save" failure from dev flow logs | next device run |
| 8 | Capture UI design pass (forms-designer), after the restyle lands | after T3 works |
| 9 | Tape-measure validation on 10 legs, accuracy log | after T3 works |
| 10 | DESIGN.md sections 5, 6 and 12 updated with the tiers and the YOLO decision | with the T3 commit |
| 11 | T1 trial on a borrowed LiDAR iPhone | when a phone is available |

---

## 10. Risks and open questions

1. Mask quality on low-contrast skin against similar backgrounds. Mitigations:
   torch, contrast tips, a mask check before the shutter. Fallback: a
   permissively licensed segmenter, never AGPL.
2. Children: wiggling breaks the "still" condition. Expect T4 and S/M/L presets
   (DESIGN.md section 7a.3) for the youngest.
3. The ISW/ICW/ISD/ICD meaning in Zane's model. This decides whether the
   ellipse estimate is good enough or a richer shape model is needed.
4. ARKit relocalization mid-capture: tracking is required to be normal at each
   shutter, and a relocalization event invalidates earlier stations (retake).
5. The Onshape Free plan makes job copies public, a blocker for real customers
   (DESIGN.md section 10a).
6. This repo is public on GitHub. It holds no body data or secrets, by
   construction: recordings are gitignored and keys live in .env.

## 11. Decisions Liam owns

- Accept "outer width and depth measured, inner split estimated" for the solo
  tier until the Zane walkthrough says otherwise.
- The minors' data retention period, with legal.
- An Onshape paid plan or company account before the first real customer.
