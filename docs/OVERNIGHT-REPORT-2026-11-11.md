# Overnight report, 2026-11-11

Unattended session, 22:26 on 2026-11-10 to about 02:00 on 2026-11-11 EST
(finished early; the brief allowed until 07:00), branch
`feat/overnight-2026-11-11` (not merged to develop). Brief:
docs/OVERNIGHT-2026-11-11.md. This is the final state.

## Read this first

1. **Scan goal met: bad videos now give a clear, fixable failure, never
   garbage.** IMG_3836 fails on "knee outside the frame"; IMG_3834 measured
   with human cross-sections at silhouette v3, then became a bent-knee
   retake at v4. Six real defects were found and fixed along the way (cut-off
   views failed whole scans, a twisting loft, the floor fit, an upside-down
   phone, a misleading ankle reason, the bent-knee length loss).
2. **Most urgent decision: the capture pose.** The bent-knee retake plus the
   30 degree shin-tilt gate leave no ordinary seated pose that passes both.
   Options in SCAN-V3-PLAN.md 5.1 and under TODO(liam) below.
3. **Built beyond the scan:** the estimator (unwired) and its contracts, a 3D
   viewer spike, the sweep capture behind a flag, admin catalog, photos,
   remakes, partial refunds and customer lookup, a UI pass on both apps,
   checkout gates (all off), policy page shells, and a security review with
   its fixes. Everything verified green; nothing ran on a phone.
4. **Deploy order if any of it ships:** migrations 0018 to 0026 (0020
   unused) before the web build (0025 before the refund webhook change).
5. **Never create a 100%-off promotion code** until the webhook handles it.

## Brief checklist (docs/OVERNIGHT-2026-11-11.md, item by item)

| Brief item | Status | Evidence |
|---|---|---|
| Branch feat/overnight-2026-11-11, never main, not merged | met | every commit on the branch; develop and main untouched |
| Read-first docs, operating procedure per task | met | contracts pinned before building (2d15b35, 5022b62); forms-architect reviewed Phase 1 first |
| Delegate big pieces; subagents leave changes uncommitted; orchestrator reviews and commits | met | every code commit reviewed and verified by the orchestrator before commit |
| No git add -A, no stash, git alone in its own calls | met | explicit-path commits only |
| Tests with every change; verification commands pass | met | Verification section; `make lint typecheck test` and SQL checks green |
| No emojis, no em or en dashes, Conventional Commits, no AI attribution | met | dash scans on every commit; three pre-existing dash cases fixed |
| Onshape: copies only, never the original | met | no Onshape call at all |
| No system packages, no AGPL, no external data, no human-only work (device runs) | met | only MIT/BSD/Apache npm deps; `pod install` regenerated gitignored files only; device runs are human-only per line 44 of the brief, so none were attempted |
| Videos treated as body data; derived output only under recordings/ or the scratchpad (brief line 62) | met | nothing committed or uploaded; docs carry counts and ratios only |
| 1. Swift harness CLI (AVFoundation keyframes, Vision mask and pose, PhotogrammetrySession, bundle) | met | bf48577 |
| 1. Python driver and results table | met | 9424e5c, 5e1ffb3 |
| 1. Scale-free metrics, gate reasons, mask quality, agreement | met | results.md per run; agreement table needs two measured videos |
| 1. Iterate until bad videos give a sane leg or a clear, fixable failure | met | both end in fixable framing or pose reasons; six real defects fixed (d39e5f1 to e43035b) |
| 1. Tests for every fix on synthetic legs, never the videos | met | test_silhouette_cutoff, _loft, _tilt, _typed_length, test_bent_knee, test_harness_* |
| 1. docs/VIDEO-HARNESS.md: how to run, what each video taught | met | a957033, 0d8c801, 9f781cb |
| 1. Note in SCAN-V3-PLAN.md 5.7 on tape scale | met | 2d15b35, corrected to two values in 0d8c801 |
| 1. Estimator ideas, sweep spike, capture UX where they help | met | 5e1ffb3, ff4c296, 8192b45, SCAN-V3-PLAN.md 5.3 lessons |
| If time: Phase 1 estimator, architect review first, migrations 0018, 0019, 0021 | met | a81fca2, 6159a30, 89c2e50; migrations 802e730 (first deferred on the architect's advice, then built unwired) |
| If time: Phase 2 r3f + expo-gl spike (stop and report if it fails) | met (passed) | d373476; full iOS simulator app build succeeds; on-device rendering is human-only |
| 2. Admin products, photos, orders, tracking, refunds, remakes, customer lookup; authz, RLS, validated uploads, migrations from 0022 | met | 9ccd578, 7b3369f, c7978b2 |
| 2. UI and UX pass led by forms-designer | met | e4b8960, 8aa4481 |
| 2. docs/BUSINESS-GAPS.md and top code-only items | met | 5ad999e, b6f4a8d, 0b51a39 |
| Loose end: fitPreview Club 0.12 to 0.88 | met | 5054ca1 |
| Report kept current and pushed after each milestone, finished before 07:00 | met | this file |

Not a brief requirement, reported as findings: the estimator's provisional
feasibility table misses the plan's "full sweep is none" target (the plan
says tolerances or capture change, not the bands); nothing ran on a phone
(human-only).

## Status at a glance

| Area | State |
|---|---|
| Video harness: Swift forms-video | done (bf48577) |
| Video harness: Python driver | done (9424e5c) |
| Iteration on the two test videos | done: both give fixable failures (IMG_3834 bent knee, IMG_3836 knee out of frame); d39e5f1 to b9d9b15 |
| Bent-knee rule (silhouette v4) | done (b9d9b15); pose decision open |
| Typed Leg_Length mode (resolves the pose conflict, unwired) | done (e43035b) |
| Estimator verdict in the harness, prior 0.1.1 | done (5e1ffb3, 89c2e50) |
| Phase 1a estimator (pure, unwired) and shared contracts | done (5022b62, 6159a30, a81fca2) |
| Phase 1 migrations 0018, 0019, 0021 (unwired) | done (802e730) |
| Phase 2 3D viewer spike (r3f + expo-gl) | pass on web and bundling (cfb44c0, d373476); native untested |
| Admin product management | done: catalog and photos (9ccd578), orders depth (7b3369f) |
| Phase 0.5 sweep capture spike (Swift, behind a flag) | built, off by default (ff4c296, 8192b45); untested on a device |
| UI and UX pass | done: apps/app (e4b8960), apps/web (8aa4481) |
| Business gaps, code-only items | done: checkout gates (b6f4a8d), FAQ, sizing and returns shells, print queue and packing slip (0b51a39) |
| docs/BUSINESS-GAPS.md | done (5ad999e), updated as items shipped |
| App Shop tab follows the catalog | done (dfac25b) |
| Security review of tonight's web and SQL | done, fixes in c7978b2 |

## Verification (run by the orchestrator, 2026-11-11 about 01:15)

- `make lint typecheck test`: exit 0. Pipeline 1051 passed; shared 142,
  app 510, web 534 tests (593 after the security fixes, re-run); ruff, tsc and ESLint clean.
- `pnpm turbo run build typecheck test` and `pnpm format:check`: green.
- `bash supabase/tests/run_sql_checks.sh`: all SQL checks passed (including
  catalog_checks.sql and order_ops_checks.sql).
- Swift: `swift build -c release && swift test` in services/reconstruct (23
  tests) and `swift test` in apps/app/modules/forms-capture/logic-tests (34
  tests): green.
- Full iOS app build: `pod install` (in the gitignored, generated
  apps/app/ios) then `xcodebuild -workspace FORMS.xcworkspace -scheme FORMS
  -sdk iphonesimulator ... CODE_SIGNING_ALLOWED=NO`: BUILD SUCCEEDED,
  including the sweep capture Swift and the expo-gl module.
- Nothing ran on a phone.

## Done (with commits)

- Contract for the harness bundle (forms.video-bundle v1) written into
  docs/VIDEO-HARNESS.md before either side was built.
- SCAN-V3-PLAN.md section 5.7: tape measurements add real scale (2d15b35;
  corrected later to two values under the provisional numbers).
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
  corrupts any slice that lands in that band. Fixed in d39e5f1.

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
  route validates admin aal2, same origin plus custom header, a streamed size
  cap (5 MB, lowered to 4 MB in c7978b2), magic bytes and dimensions, and builds the path server-side. Checkout
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
  simulator SDK, and the full app builds for the simulator after `pod
  install`. To try it on a phone: a dev client build (EAS runs pod install),
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

- Security review (c7978b2): an independent read-only review of migrations
  0022 to 0026 and the new admin routes found no critical or high issues.
  One medium, proven with a probe: an admin could remake an order for a
  customer with a pending account deletion, reprocessing a scan they asked
  us to delete; now refused in SQL and the panel. Also fixed: refund mode
  no longer defaults to full; refunds reconcile with Stripe first so a
  retry cannot refund twice; uploads capped at 4 MB, cached one hour,
  EXIF/GPS stripped, animated WebP refused; admin pages show only fixed
  messages. Three lows are in KNOWN-ISSUES (customer search email in the
  URL, refund.updated, zero-total promo codes). 593 web tests.

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

At 120 sampled frames:

| | IMG_3834 | IMG_3836 |
|---|---|---|
| Result at silhouette v3 (8ebbd81) | **measured** | fail: "The knee was outside the frame in most of the photos" |
| Final result at silhouette v4 (b9d9b15) | retake: "The knee was bent too far to measure; sit with your foot further forward so the leg is straighter." | unchanged |
| Registered / submitted | 119 / 120 | 103 / 103 |
| Keyframes / span | 22 / 200 deg | 19 / 173 deg |
| Up source | floor plane, shin 18 deg | leg axis (no floor) |

IMG_3834 ratios: OD/OW 0.88, 0.91, 0.93, 0.96 (S1 to S4); OW/OW_S3 0.69,
0.87, 1.00, 0.96; Leg_Length/OW_S3 2.62. OD/OW and the profile shape are
human. Leg_Length/OW_S3 reads short (adults are usually above 3). No
agreement table: only one video measured.

Bent knee (b9d9b15): on a synthetic hinged leg Leg_Length came out -2.9% at
60 degrees of knee bend and -14.6% at 90, in both reconstruction paths,
because the thigh hides the dip below the kneecap. A knee bent past about 60
degrees is now a retake asking for a straighter leg, and IMG_3834 fails that
way. The bend explains at most about 5% of its short ratio; the rest is
unexplained until tape ground truth.

Estimator in the harness (5e1ffb3, report only): on IMG_3834 (v3 geometry)
the gate fails a scale-free capture and asks for tape Leg_Length; even with
it r is about 1.1 ("required") and it then asks for one depth. Under the
provisional numbers a plain video needs two tape values, not one. Full
write-up in docs/VIDEO-HARNESS.md.

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

- **Scan, the most urgent product decision: the capture pose.** The seated
  "foot flat, shin upright" pose bends the knee near 90 degrees, which
  measured Leg_Length up to 15% short on synthetic legs, so silhouette v4
  refuses knees bent past about 60 degrees. With the thigh horizontal, knee
  bend is about 90 degrees minus the shin's lean, and the posture gate
  refuses a lean past 30 degrees, so **no ordinary seated pose passes both
  gates today**. Options are in SCAN-V3-PLAN.md 5.1: standing with a helper;
  a high seat with the leg forward and MAX_TILT_DEG opened to 40 (the math
  holds there); a knee landmark that does not need the dip; or, my
  recommendation, Leg_Length from one tape number (plain video needs a tape
  value for scale anyway), so the scan only finds the ankle and the four
  slices stay below where the thigh enters even at 90 degrees. That option
  is built and proven on synthetic legs (e43035b: every slice within 0.7%
  of a straight leg at up to 90 degrees of bend) but not wired; wiring is
  an optional `leg_length_mm` in capture.json or the manual payload, the
  handler call, and a Leg_Length override in the measure step. I kept the
  retake (a failed scan is reversible, a short guard is not) and did not
  change the app's capture copy, because the right pose is your call. Until
  then, station and sweep captures in the current pose will fail late with
  the bent-knee reason.
- **Phase 1 migrations 0018, 0019, 0021 (802e730), shipped unwired.**
  forms-architect first advised deferring them; to follow the brief they
  were then built in the safest form: deny-by-default tables, an
  owner-checked refusion RPC with no caller yet, and an order snapshot that
  runs in a guarded block and can never block a payment (a test forces a
  failure). Decide: whether pending_payment orders should also block
  re-fusion; whether measurement_quality belongs in the data export (legal
  call); whether a fit remake should use newer measurements instead of the
  original's snapshot. If 0022 to 0026 are ever applied before these on a
  hosted database, push with `supabase db push --include-all`.
- Estimator noise levels, the bootstrap prior and the gate tolerances (15 mm
  Leg_Length, 6 mm fit-critical OW and OD) are provisional placeholders,
  flagged `provisional` in the files, until the Phase 0 calibration.
- Scan: MAX_TILT_DEG stays 30. The math holds at 40 on synthetic shins
  (tests/test_silhouette_tilt.py); opening the gate is a product call.
- Scan: segment.py's bent-knee rule also changes the photogrammetry path for
  bent-knee inputs only (short leg becomes a rescan). No version constant
  covers segment.py; decide whether that needs one.
- Scan: IMG_3834's short Leg_Length/OW_S3 (2.62) is only about 5% explained
  by the bend; tape ground truth will say whether OW_S3 reads wide at close
  range. If its knee really was at the flat stretch, the window rule is too
  strict for profiles that flatten before the thigh, and a flatness test
  could replace it.
- Estimator: prior 0.1.1 (89c2e50) fixed the OW/OD definition, but
  extraction's OW is the larger section extent, not the anatomical
  mediolateral width, so the leg model's x and y inherit that until the
  anatomical frame lands (KNOWN-ISSUES).
- Estimator: a scale-free capture needs two tape values (Leg_Length plus one
  depth) under the provisional numbers, not one as plan 5.7 first said.
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
- Catalog: EXIF is now stripped, including the orientation tag, so upload
  photos already upright (the upload hint says so). Animated PNG is not
  refused.
- Refunds: admin messages no longer echo Stripe's decline reason or exact
  ranges (fixed messages only); use the Stripe dashboard for detail.
  Reconciliation records dashboard refunds into the panel's ledger under the
  admin who triggered it.
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

None. No Onshape call was made tonight.

## Body data handling

The two videos and everything derived from them stayed on this Mac: bundles
and results under services/pipeline/recordings/ (gitignored), plus a session
scratchpad. Nothing was committed or uploaded; docs carry counts and ratios
only. The mask contact sheets, logs, the frame-derived image and the scratch
bundle copy were deleted from the scratchpad by explicit path; what remains
there is scripts and fake-data web screenshots, no body data. The derived
bundles and results under services/pipeline/recordings/ stay, as the brief
allows.

## What failed and why

- **Neither test video produces a final measured leg.** IMG_3836 never sees
  the knee from enough of the arc (the knee end is off the frame in 15 of 18
  keyframes). IMG_3834 measured at silhouette v3, then became a retake at v4
  because its knee is bent near 90 degrees, a pose shown to shorten
  Leg_Length by up to 15% on synthetic legs. Both are framing or pose
  limits the user can fix, which is the brief's acceptable outcome; neither
  is a math failure.
- **The 3D viewer could not use the shared leg-model contract in React
  Native** at first (it pulled in a module that reads the schema with
  node:fs). Fixed in cfb44c0 with bundle-safe subpath exports.
- **A full Xcode simulator build of the app failed** at first because
  `pod install` had not run since the new SweepCaptureLogic.swift was added.
  After `pod install` (generated, gitignored files only) the full simulator
  build succeeds.
- **The estimator's feasibility targets are not met** under provisional
  numbers: a full sweep comes out "required" (Leg_Length binds), and a
  scale-free capture needs two tape values, not one.
- **Prior 0.1.0 used the wrong width definition** (anatomical mediolateral
  instead of extraction's larger section extent): its OD/OW was 1.10 to
  1.17 where extraction reads 0.86 to 0.91 on the same synthetic leg. Found
  by the harness estimator stage and fixed as prior 0.1.1 (89c2e50), now
  the default; 0.1.0 is kept unchanged.
- Rule slips by subagents: several ran a read-only `git diff --stat` despite
  the no-git rule (no effect). One test file and two others had literal
  dash characters in assertions; replaced with escapes before commit.

## Next steps

In order, for Liam:

0. **Decide the capture pose** (top TODO above); until then every seated
   scan fails on the bent-knee rule.
1. **Tape ground truth (Phase 0, human-only).** Five then ten legs with tape
   and books, logged in docs/accuracy-log.md. Everything provisional tonight
   (estimator noise, tolerances, the bent-knee window, IMG_3834's short
   Leg_Length/OW_S3) waits on it.
2. **Record two good videos** of one leg in the chosen pose (knee only
   slightly bent, whole lower leg plus a little thigh in frame across a
   front half-circle, floor visible around the foot), drop them in services/pipeline/recordings/videos/,
   and run `.venv/bin/python -m forms_pipeline.harness run`. That gives the
   first agreement table between two videos of the same leg.
3. **Try the sweep on a phone:** a new dev client build (it must include
   expo-gl and the new Swift file; `pod install` already ran locally),
   EXPO_PUBLIC_SWEEP_CAPTURE=true and SWEEP_CAPTURE_ENABLED=true, then
   tune the values listed under TODO(liam).
4. **Decide the product calls** listed under TODO(liam), the most urgent
   being the gate tolerances with Zane and the
   remake versus refund policy.
5. **Deploy order** if any of this ships: migrations 0018 to 0026 (0020
   unused) before the web build (0025 before the refund webhook change),
   then the app.
6. **Phase 1b** (estimator wiring onto the 0018, 0019 and 0021 tables, the
   CAD job reading the order snapshot) after step 1, reviewed as one
   security surface.
7. Review and merge this branch into develop (not done tonight, per the
   brief).
