# Overnight report, 2026-11-11

Unattended session, 22:26 to 07:00 EST, branch `feat/overnight-2026-11-11`
(not merged to develop). Brief: docs/OVERNIGHT-2026-11-11.md. Updated after
every milestone, so the latest commit on the branch holds the latest state.

## Status at a glance

| Area | State |
|---|---|
| Video harness: Swift forms-video | done (bf48577) |
| Video harness: Python driver | done (9424e5c) |
| Iteration on the two test videos | done: IMG_3834 measures, IMG_3836 fails on the knee (da80ef4, 8ebbd81, a957033) |
| Phase 1a estimator (pure, unwired) and shared contracts | done (5022b62, 6159a30, a81fca2) |
| Phase 2 3D viewer spike (r3f + expo-gl) | pass on web and bundling (cfb44c0, d373476); native untested |
| Admin product management | done: catalog and photos (9ccd578), orders depth (7b3369f) |
| Phase 0.5 sweep capture spike (Swift, behind a flag) | built, off by default (ff4c296, 8192b45); untested on a device |
| UI and UX pass | done: apps/app (e4b8960), apps/web (8aa4481) |
| Business gaps, code-only items | done: checkout gates (b6f4a8d), FAQ, sizing and returns shells, print queue and packing slip (0b51a39) |
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

- Phase 2 viewer spike (d373476), plan risk 6: three 0.187.0,
  @react-three/fiber 9.8.2 and expo-gl 57.0.3 (all MIT) install with no peer
  conflicts under Expo 57, typecheck, and bundle for web, iOS and Android.
  Rendered on web in headless Chrome (yellow leg, Club band at 0.2 to 0.8).
  three is a 1 MB lazy chunk on web and adds about 2.7 MB of bytecode on
  native. The spike found that the shared leg-model contract could not load
  in React Native (it pulled in a module that reads the schema with node:fs);
  fixed in cfb44c0 with bundle-safe subpath exports. The viewer is on a
  dev-only route; no production screen uses it yet.

- Admin catalog (9ccd578): migrations 0022 (display order, availability
  available / coming soon / paused, sizing modes sold, "available" needs a
  CAD model) and 0023 (product_images, public product-images bucket). Upload
  route validates admin aal2, same origin plus custom header, a streamed 5 MB
  cap, magic bytes and dimensions, and builds the path server-side. Checkout
  refuses anything not purchasable. Fixed the admin order page crash for
  deleted accounts. I removed the agent's storage select policy on the photo
  bucket: public URLs work without it and it let anyone list photo names for
  paused products. SQL checks pass. The app Shop tab and order picker follow
  the same rules (dfac25b).

- App UI pass (e4b8960), led by forms-designer: wordmark on sign-in,
  shared error and loading states with a real retry (web had none), correct
  device copy (any iPhone on iOS 17), plain measurement labels, brand fonts
  in native headers, honest disabled and busy buttons, tab bar from the
  safe-area inset, helper-mode capture copy. Visual and copy only. Tests 458
  to 487.

- Phase 0.5 sweep capture (ff4c296, 8192b45): pure SweepCaptureLogic.swift
  (azimuth keyframes up to 24, span across the wrap, Done and auto-stop
  gated on a near-side view and the knee end in frame across the arc,
  leg-relative framing checks where toes and thigh never warn, coverage
  credited only for heights in frame, one instruction at a time) with 34
  Swift tests in apps/app/modules/forms-capture/logic-tests. Controller sweep
  mode reuses the station writer. Python and the app validator accept sweep
  bundles only with SWEEP_CAPTURE_ENABLED. The module compiles against the
  simulator SDK. To try it on a phone: `pod install` (the new Swift file is
  not in the Pods file list yet), a dev client build,
  EXPO_PUBLIC_SWEEP_CAPTURE=true in the app env and SWEEP_CAPTURE_ENABLED=true
  on the worker.

- Admin orders (7b3369f): remakes (0024, zero-cost paid orders linked to
  the original, never Stripe, one open remake per order, CAD jobs through the
  existing paid trigger), partial refunds (0025, ledger plus Stripe's
  cumulative total so admin and dashboard refunds are not double counted),
  customer lookup, append-only notes and an order timeline (0026), and four
  new plain-text emails. 440 web tests and the SQL checks pass. **Deploy
  migration 0025 before this web build**: the charge.refunded handler calls
  its new RPC and would return 500 (Stripe retries) until it exists.

- Web UI pass (8aa4481), led by forms-designer: the checkout success and
  cancelled pages were visibly broken (missing classes, invisible wordmark)
  and are fixed; device copy; drawn wordmark; per-page Open Graph and a share
  card; honest busy and disabled buttons; retry on every error state; admin
  usable at 360 px with 44 px targets and visible focus on brown. Checked at
  360 px in fake mode with no horizontal overflow on any route. 453 web
  tests.

- Checkout gates (b6f4a8d): STRIPE_AUTOMATIC_TAX, STRIPE_SHIPPING_RATE_IDS,
  STRIPE_TERMS_CONSENT, STRIPE_ALLOW_PROMOTION_CODES, all off unless set,
  params identical to before when off (frozen-baseline test).
- Pages and fulfillment views (0b51a39): /faq, /sizing, /returns with repo
  facts only and visible "coming before launch" placeholders; admin print
  queue and a packing slip that carries no prices, measurements or scan
  data. 534 web tests.

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
deg. The unregistered stretches were the knee close-ups.

Round 2 (da80ef4 silhouette v3, 8ebbd81 harness): the denser cloud let a
compact clump beside the foot beat the floor on point count; planes are now
ranked by covered area and must support the leg. IMG_3836's "ankle" failure
was really the truncated knee end shrinking the ankle search window; the
reason now names the knee. 120 frames is the harness default.

Final (120 sampled frames):

| | IMG_3834 | IMG_3836 |
|---|---|---|
| Result | **measured** | fail: "The knee was outside the frame in most of the photos" |
| Registered / submitted | 119 / 120 | 103 / 103 |
| Keyframes / span | 22 / 200 deg | 19 / 173 deg |
| Up source | floor plane, shin 18 deg | leg axis (no floor) |

IMG_3834 ratios: OD/OW 0.88, 0.91, 0.93, 0.96 (S1 to S4); OW/OW_S3 0.69,
0.87, 1.00, 0.96; Leg_Length/OW_S3 2.62. OD/OW and the profile shape are
human. Leg_Length/OW_S3 reads short (adults are usually above 3); the likely
cause is the bent knee putting thigh into the knee slices. No agreement table:
only one video measured. Full write-up in docs/VIDEO-HARNESS.md.

## Untested on a device

Nothing from this session has run on a phone. Everything below that touches
capture is Mac-side only.

- 3D viewer on iOS and Android: needs a new EAS dev client build that
  includes expo-gl. On the current dev client the viewer shows its fallback
  text. Touch orbit and the plan 7.6 performance budget (iPhone 12, 60 fps,
  first render under 300 ms) are unmeasured.
- Sweep capture: everything. Vision rate and heat at 4 checks a second,
  whether the motion and sharpness limits pass enough frames in an 8 to 12
  second sweep, the knee estimate (mirrored from the floor about the aim
  anchor), the too-close rule on real masks, the flat ghost-leg bar and
  haptics, and the round trip to reconstruct_silhouette on 12 to 24 views.
- App UI pass: tab bar height with a real home indicator and Android gesture
  nav, brand fonts in native headers, largest accessibility text sizes.
- The forms-video CLI and harness run on the Mac only; the capture lessons
  they produced (section below) are not yet in the phone build.

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
- Scan: MAX_TILT_DEG stays 30. The math holds at 40 on synthetic shins
  (tests/test_silhouette_tilt.py); opening the gate is a product call.
- Scan: Leg_Length under a bent knee (IMG_3834 ratio 2.62) needs tape ground
  truth; if confirmed short, the knee landmark rule needs a bent-knee case.
- Scan: segment.ANKLE_SEARCH_FRACTION (40% of the profile) is shared with the
  photogrammetry path and was not changed; only the failure wording was.
- Scan: new failure copy says "photos" to match the station capture; the
  sweep will need "video" wording. Only one failure reason is shown at a
  time.
- Harness: floor-rule constants (leg-below 2%, floor gap 0.5 of leg height,
  cell size 3 tolerances, floor tilt 50 deg) are principled guesses. With no
  floor, up comes from the leg itself and the tilt gate is not exercised.
- Catalog: a product row is one model tier (Club, Pro, Junior Max) and
  `sizing_modes` is the "tiers sold" (custom, preset S/M/L); checkout sells
  custom only. Confirm, or ask for a grouping column.
- Catalog: preset S/M/L value sets, lead time and capacity, launch
  availability per product, prices and the photos themselves are not set.
- Catalog: photo EXIF/GPS is not stripped (needs an image library or a
  photographer workflow).
- App: Android and web users with no scans have no entry point to hand
  measuring (needs a navigation decision).
- App: capture failure screens show "Code: ERR_..." to users; added on
  purpose earlier, so left for Liam.
- App: delivery time and the remake or returns policy should appear before
  payment (order/[key].tsx); neither is decided, so nothing is shown.
- App: the guard-pair product render has a soft glow and drop shadow that
  brushes against the no-glow rule; judge it or swap in a real photo.
- Sweep: tuning values to set from device runs (ankle 0.08 m above the
  floor, anchor to ankle 0.20 m clamped 0.12 to 0.30, thigh margin 0.06 m,
  edge margin 3%, side band 15% to 90% of the shin, motion limit 0.8 rad/s).
  "Knee seen in all three thirds of the arc" may be too strict at the arc
  ends. The in-AR ghost leg, voice prompts and the bent-knee prompt are not
  built; the ghost leg is a flat 8-segment bar for now.
- Orders: the remake versus refund policy (who qualifies, time window,
  return shipping); whether a fit remake needs a rescan first; whether a
  fully refunded order may also be remade; refunding delivered orders stays
  Stripe-dashboard only; what the refund, cancel and remake emails say about
  money timing and returning the original (left out). The rescan email has
  no caller yet (the pipeline gate failure must trigger it).
- Web: the privacy page still describes LiDAR and non-LiDAR capture; it is
  legal text, so left for review. Privacy and terms placeholders (entity,
  address, retention, liability, governing law) remain. The waitlist's
  "Check back in a few days" is close to an invented timeline. The web uses
  a 4 px radius and the app 8 px; pick one.
- Checkout: turning on each gate needs dashboard setup first (tax
  registrations and Stripe Tax settings; carrier, rates and countries; the
  terms URL in Stripe's public settings; promotion codes). **Never create a
  promotion code that can make the total zero** until the webhook handles
  no_payment_required (today such an order would stay pending forever).
- Pages: 13 placeholders on /faq, /sizing and /returns (material, care,
  delivery time, shipping countries, cancellation wording, growing kids,
  scan tips, pair pricing, returns window, remake vs refund, return
  shipping, refund timing).
- Estimator conservative defaults: manual input accepts any non-empty subset
  of the 9 typed keys; a missing or invalid tolerance makes the gate fail,
  never pass; keys already typed are not offered as tape actions.

## Onshape copies created

None.

## What failed and why

Nothing yet.

## Next steps

To be written at the end of the session.
