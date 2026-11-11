# Scan v3: capture what you can, model the rest, show it in 3D

Written 2026-11-10. Working plan for the next generation of the scan, the
estimation layer behind it, and the 3D leg-and-guard preview. Builds on
docs/SCAN-PLAN.md (the 2026-09-30 device evidence and the T1-T4 tiers), which
stays the record of what was tried. Architecture truth stays in DESIGN.md:
each decision here moves into DESIGN.md in the same commit series that ships
it (sections 5, 6, 7a.3 and 8 are the ones affected).

---

## 0. The plan in twelve lines

1. Stop treating the scan as "complete mesh or rescan". Treat it as one sensor
   among several feeding a single **leg estimator**.
2. The estimator holds a **statistical leg model** (a prior over leg shapes),
   and every source (video sweep, LiDAR depth, tape measure, the player's
   height and age, the other leg) is an observation with an uncertainty.
3. Its output is always complete: all 25 values, a smooth 3D leg model, and a
   per-value confidence. Gaps are filled by the model, not shown as holes.
4. Capture becomes **one short video sweep** in front of the shin, the same on
   every iPhone. LiDAR phones add depth to the same sweep. No stations to hit,
   no circling the leg.
5. Only leg outlines, camera poses and joints leave the phone. **Photos stay
   on the device** (optional consented upload for training only).
6. Confidence drives a **fit-risk gate**. High confidence goes straight to the
   reveal. Lower confidence adds one short check card, chosen as
   the single action that most reduces the risk. Nothing unsafe is printed.
7. After the scan, a **3D model of their leg** spins in and the guard snaps
   onto it. They can rotate it, switch guard models, see the coverage as a
   percent of their leg, and compare custom against a stock S/M/L.
8. The 3D leg is generated from the estimator, not the raw scan, so it is
   always complete, small, consistent across every capture tier (manual
   included), and is exactly the shape the guard is built from.
9. The 25-value contract does not change. Confidence, provenance and the leg
   model are new, separately versioned contracts beside it.
10. The state machine does not change. Estimation runs inside the measuring step.
11. Delivery is in phases, ordered so each ships value alone: first a real
    printed guard and tape-measured ground truth, then a cheap sweep spike on
    the existing math, then the estimator, the 3D preview, and the full
    capture.
12. Before any of it is trusted: tape-measure ground truth on real legs.

---

## 1. What Liam asked for (acceptance criteria)

| # | In Liam's words | What it means for the build |
|---|---|---|
| A | "scan the leg and get as much as we can ... realistically we won't" get everything | Partial captures are the normal case, not an error. Every capture produces an estimate. |
| B | "estimate or predict based on other stuff ... fill in gaps ourself" | A prior over leg shapes plus cheap side information (height, age, other leg) fills what the scan missed. |
| C | not "obvious to the user that the scan isn't getting stuff" but "help indicate it to a degree" | No error states for missing data. One soft quality signal, and one optional refinement step when it matters. |
| D | "feel easy" and "feel like they are getting a custom solution" | A short, single-gesture capture, a personal 3D reveal, their own numbers on their own leg. |
| E | Pro model (LiDAR) uses LiDAR, untested; "most people ... from just a normal video" | One capture flow for all iPhones; LiDAR is an extra data channel, not a separate flow. Video sweep is the default. |
| F | "a preview of a model of their leg ... visualize the shin guard on their leg ... spin it around" | A 3D viewer after the scan: their leg, the guard on it, orbit and zoom. |
| G | "for sizes a percent of their leg ... show them the size on the model" | Coverage band drawn on the leg as a percent of Leg_Length, per guard model, and S/M/L preset vs custom on the same leg. |
| H | "we will iterate over the scan with time" | Every part is versioned (prior, estimator, capture format) and every real attempt is replayable, so accuracy improves without rescans. |

Plus the standing product constraints: measurements accurate enough to print
a guard that fits (ROADMAP targets: Leg_Length within 2%, widths and depths
within 3-5%), scans of minors handled as the most sensitive data we hold, and
zero manual CAD per customer.

---

## 2. Honest baseline (what is true on 2026-11-10)

| Fact | Source |
|---|---|
| Server path after the photos is proven: replayed 60-photo leg measured Leg_Length 365.5 vs 370 mm (1.2%). | SCAN-PLAN.md section 2 |
| Solo circling fails physically: coverage 19-44%, many "too close"/"blurry". | SCAN-PLAN.md section 2 |
| 5-station silhouette (T3) built on both sides; first iPhone 16 run exposed aim, mirroring and clutter bugs, fixed in 602dbf1, da1b01b. No measured real leg yet. | git log, SCAN-PLAN.md section 9 |
| The silhouette math is ellipse-per-slice from tangent lines; synthetic legs within 0.6%. | reconstruct/silhouette.py, ef09200 |
| Zero tape-measure ground-truth entries. | docs/accuracy-log.md |
| "Won't save" upload failure on device is still unexplained. | SCAN-PLAN.md section 9 item 7 |
| LiDAR path (T1, ObjectCapture) never run on a LiDAR phone. | SCAN-PLAN.md section 4 |
| Manual entry derives the 16 inner values as a symmetric split (ISW = ICW = OW/2, ISD = ICD = OD). | apps/app/src/lib/manualMeasurements.ts |
| The 2D FitPreview draws leg and guard from the 25 values with ellipse sections and template coverage fractions (Club 0.12-0.88 of Leg_Length; corrected to 0.2-0.8 on 2026-11-11). | apps/app/src/lib/fitPreview.ts |
| The meaning of ISW/ISD/ICW/ICD inside the Onshape model is still unconfirmed. | DESIGN.md section 12.2 |
| A guard has been printed and fit well (2026-11-10), from values set by hand in Onshape and a hand export. The automated scan-to-STL round trip has not run; Onshape API access is confirmed. | ROADMAP.md section 14, accuracy-log.md |

Read together: the expensive parts work, the solo capture is the weak link,
and nothing is yet validated on a real leg. This plan fixes the weak link by
needing less from it, and makes the validation the first phase, not the last.

---

## 3. The core idea: one estimator, many sensors

```
  Sources (any subset)                 Estimator (server, pure numpy)          Outputs
  --------------------                 ------------------------------          -------
  video sweep: masks + poses  ----+
  LiDAR depth on keyframes    ----+
  Vision knee/ankle joints    ----+--> observations y_i, sigma_i  --+
  photogrammetry / OBJ mesh   ----+                                  |
  tape measure (manual)       ----+                                  v
  player height, age band     ----+--> prior covariates z  ---> posterior over the leg ---> 25 values (posterior mean)
  the other leg's scan        ----+--> bilateral correlation         |                  ---> per-value sigma + provenance
                                                                     |                  ---> leg model (rings, 3D)
                                       versioned prior (data file) --+                  ---> fit-risk verdict
```

Every tier we already have (T1 LiDAR mesh, T2 helper sweep, T3 silhouettes, T4
manual) becomes a source. The estimator does not care which arrived; it
conditions the prior on whatever did. That is what makes "get as much as we
can" safe: missing data widens the uncertainty instead of breaking the job.

Why this shape and not "better reconstruction only":

- Reconstruction quality will keep improving, but there will always be users
  in bad light, with wiggly kids, or who stop early. A pipeline that only
  accepts complete data turns each of those into a failed scan and a lost sale.
- The guard does not need a perfect mesh. It needs 25 numbers inside a
  tolerance. Shin shape is highly regular between people; a good prior plus a
  partial scan reaches that tolerance much sooner than reconstruction alone.
- One estimator gives one place to measure accuracy, one place to improve, and
  one leg model that every screen and every product renders.

---

## 4. The leg model (prior, fusion, gap filling)

### 4.1 Representation

A leg (one side) is the vector

```
x = [ log L,
      log w(t_1..t_K),            outer width  (OW)  at K heights
      log d(t_1..t_K),            outer depth  (OD)  at K heights
      a(t_1..t_K),                anterior offset: where the shin crest sits within the depth
      m(t_1..t_K),                medial share of the width (drives ISW/ICW)
      s_j(t_1..t_K), j=1..J ]     cross-section shape coefficients (Fourier, normalized)
```

- t runs 0 (bottom of the ankle) to 1 (knee), matching the contract's slice
  convention, so S1..S4 are t = 0.2, 0.4, 0.6, 0.8 exactly.
- K = 21 heights (every 5% of leg length). J = 4 shape harmonics to start.
- Logs make every size positive and make scale errors additive, which is what
  ARKit drift and population variation actually look like.
- The cross-section at height t is a closed convex contour: the ellipse (w, d)
  deformed by the shape harmonics and shifted by a. A canonical shin section
  (flat medial tibia face, anterior crest, rounder calf) is the mean shape;
  harmonics express individual variation. This is what lets us output
  ISW/ISD/ICW/ICD from a model of anatomy instead of a symmetric split.

Plus **nuisance states**, estimated alongside the leg and then discarded:
a log scale bias for the whole capture (ARKit drift, about 1-2%), a small
pose correction per view (as silhouette.py's refinement does today), the leg
axis, and the ankle origin z. These errors are shared by every observation
from one capture. Modelled as states, they are counted once. Left out, a
few thousand tangent lines would look like independent evidence, shrink
sigma as 1/sqrt(N), and make the gate overconfident.

The 25 contract values are deterministic functions of x evaluated at the
model's contour at t = 0.2..0.8 (strictly, f(posterior mean), not posterior
means of each value). The model and the contract can never disagree.

**Superseded 2026-11-11 (docs/ESTIMATOR-V1.md):** the leg model's 25-value
projection produces schema 1.1.0 **leg measurements**, the same meaning
extraction stores. It never emits crest-relative values; those are made only
by cad/profile.py (section 6a.3, DESIGN.md 12.2). The paragraph below records
the earlier concern about the inner values, which still applies when the
anatomical split replaces v1's symmetric split.
extraction/measure.py works in a PCA frame whose eigenvector signs are
arbitrary, splits each section at the mean of its boundary vertices, and has
no notion of medial or anterior. The leg model uses an anatomical frame
(section 7.2) and a real medial/lateral split. OW and OD keep their meaning;
ISW/ISD/ICW/ICD change. That requires an extraction_version bump, and the
new split ships only after the Zane walkthrough confirms what the Onshape
model means by those four (DESIGN.md 12.2). Until then the estimator emits
the inner values with the current definition.

### 4.2 The prior

The prior is a Gaussian over x conditioned on covariates z:

```
x | z  ~  N( mu(z), Sigma )
z = [ stature (if given), age band (if given) ]
```

- mu(z) is linear in z (a regression per component). With no covariates it
  falls back to the population mean, so z is never required.
- Sigma is built as a Kronecker product: a cross-component covariance (wide
  legs are also deep legs) times a smoothness kernel along t (squared
  exponential, length scale about 0.25 of leg length), so it stays positive
  semidefinite by construction, with a small diagonal jitter for numerical
  conditioning at K = 21. The kernel is
  what lets a missing S4 be extrapolated from S3 and the shape of real legs
  instead of being a hole.
- Both legs of a player are modelled jointly with a high bilateral correlation
  (start at 0.95, calibrate on data). Scanning one leg well makes the other
  leg's estimate good, and scanning both averages out capture noise.

Where the numbers come from, in order:

1. **Bootstrap (Phase 1):** published anthropometry for the scalars, a
   canonical shape for the profile. Candidates to evaluate: ANSUR II (US Army
   anthropometric survey, public, adults: stature, calf circumference, ankle
   circumference, lateral malleolus height, knee height) for adult
   relationships; CDC growth references for youth stature; a canonical width
   profile w(t)/max(w) taken from the replayed real leg and the Sketchfab
   fixture. Licensing and exact fields get checked before use, and every
   variance starts wide (honest about what we do not know).
2. **Calibration (Phase 0 data):** the 10 tape-measured legs tighten the
   source noise models (section 4.4), not the prior shape.
3. **Learned (Phase 6):** refit mu and Sigma from real scans (empirical
   Bayes, a script run by an operator, not online learning), using only rows
   whose owner recorded an explicit opt-in for model improvement. The
   existing measurements pool was collected to make guards, not to train a
   model, and purpose limitation applies, especially to minors' data. The
   opt-in is recorded per scan, and the script reads only those rows.

The prior is a versioned data file in the pipeline (`prior_version`, stored on
every measurement row next to `extraction_version`). Changing the prior is a
version bump and a replay of the regression set, never a silent edit.

### 4.3 Fusion

Each source turns its raw data into linear (or linearized) observations of x:

```
y_i = h_i(x) + e_i,   e_i ~ N(0, sigma_i^2)
```

The posterior is closed form for the linear part (Gaussian conditioning, the
same algebra as a Kalman update), with a few Gauss-Newton iterations for the
mildly nonlinear observations (contour tangent lines). Missing data is simply
missing rows; nothing special-cases "the knee was not found". Shared errors
live in the nuisance states (section 4.1), so per-observation noise is only
the truly independent part (mask edge noise). Cost: a few hundred state
variables, a few thousand observations, milliseconds in numpy. Pure
functions, no IO, fully testable on synthetic legs.

Numerical failure (a singular system, no convergence) raises a typed,
non-retriable EstimatorError with a fixed user-facing reason, never numpy
text: the same observations will fail the same way. The schema's range
gates still run on the final 25 values, exactly as today.

### 4.4 What each source observes, and how well

Starting noise levels are engineering guesses to be replaced by the Phase 0
calibration; the structure is what matters.

| Source | Observes | Starting sigma | Notes |
|---|---|---|---|
| Video sweep silhouettes (ARKit poses) | tangent lines of the section at every height seen, from both mask edges | 1.5-3 mm on OW; 2-4 mm on OD only when the sweep includes a view near 90 degrees from the front | A view at azimuth phi constrains the outline where its normal is near phi +/- 90 degrees, on both sides. A front half-circle sweep therefore constrains nearly the whole convex outline; a front-to-45-degree arc observes no front or back support at all. |
| Vision knee and ankle joints, triangulated | ankle and knee heights, so L | about 10 mm, plus a fixed offset to calibrate (Vision's ankle is not "bottom of ankle") | Seeds the landmark search; the width-profile rule makes the final cut as today. |
| Width-profile landmarks (narrowest point above the foot, dip below the kneecap) | L | about 5 mm when both ends are in view | The same rule both reconstruction paths already share. |
| LiDAR depth on keyframes | surface points on the visible front of the leg | about 5-10 mm per point, many points | Also an independent metric-scale check on ARKit. Untested on device. |
| Photogrammetry or LiDAR mesh (T1/T2, uploads) | sections at every height | 1-2 mm | Today's extraction, re-expressed as observations. |
| Tape and books (T4 manual, adjust) | L, OW and OD at the four marks | 3 mm widths, 5 mm length | **Typed values pass through unchanged** (the user sees and orders their own numbers); the model fills only the 16 inner values, replacing the symmetric split. See section 9 for the payload change. |
| Stature (player profile) | L via the prior regression | about 4-6% of L | Knee height tracks stature closely; ankle offset adds spread. Calibrate. |
| Age band | shifts mu | broad | Mostly helps children, where adult proportions mislead. |
| Other leg | everything, through the bilateral correlation | correlation, not sigma | Lets a parent scan one leg and still order a pair. |

### 4.5 Gap filling, concretely

| What the capture missed | What fills it | Effect on confidence |
|---|---|---|
| Knee cut off at the top of the frame | Vision knee joint if seen; else stature regression for L; profile above the last seen height extrapolated by the kernel | L sigma grows; S4 values lean on the prior |
| Ankle hidden by a sock or the floor | Vision ankle joint plus the calibrated offset; else floor height from ARKit plus the population malleolus height | small |
| Only a narrow arc swept (say front to 45 degrees one side) | OW well determined; OD comes from the prior (OD/OW ratio), not the scan; shape harmonics fall back to the mean section | OD sigma grows to prior level, so the check card asks for a side view |
| Back of the calf never seen | the convex outline is still constrained by the side views; the concavity, if any, from the mean section | small, and the guard sits on the front anyway |
| Bad frames (blur, mask failed) | dropped per frame; remaining frames still count | only if too few remain |
| Inner dims (ISW/ISD/ICW/ICD) | the section contour (mean shape plus fitted harmonics) split exactly as measure.py splits a mesh | honest sigma on each |
| Second leg not scanned | bilateral correlation from the scanned leg | a fixed extra sigma for asymmetry |
| Nothing usable at all | not a scan: route to manual with the diagrams (T4), never a fabricated leg | n/a |

The last row is a hard rule: the estimator fills gaps in a scan; it never
invents a leg from covariates alone and calls it custom. A covariates-only
estimate is exactly a preset (DESIGN.md 7a.3) and is sold as one.

### 4.6 Confidence, the fit-risk gate, and the check card

The **fit-critical set depends on the product**: Leg_Length (coverage), plus
OW, OD and the anterior shape at every slice inside the product's coverage
band. Club covers 0.2 to 0.8 of leg length (the model lofts S1 to S4;
fitPreview.ts corrected 2026-11-11) and Junior Max 0.08 to 0.92, so for
both, all four slices S1-S4 bear load. Only calf-side shape outside the
shell's wrap matters less.

The gate, per product (tolerances T live with the product, because a thicker
EVA liner forgives more). Let r be the worst ratio 2 * sigma(v) / T(product, v)
over the fit-critical set:

| r | Verdict (`fit_check`) | What the user sees |
|---|---|---|
| r <= 0.6 | `none` (the expected case) | Straight to the reveal. Nothing about uncertainty. |
| 0.6 < r <= 1.0 | `optional` | The reveal, plus one card: "Get a closer fit", with the action and "Order as it is". Within tolerance, so ordering as it is stays safe. |
| 1.0 < r <= 2.0 | `required` | The reveal, plus one card before ordering: "One quick check before we make it", button "Measure now". |
| r > 2.0 | fail | The scan did not see enough for a custom guard. The existing retake path with the specific reason, or manual entry. Never a guard printed on the prior alone. |

**Tolerances are derived, not guessed, and the gate must be feasible.** A
first draft of this plan set 4 mm on widths and 8 mm on Leg_Length, and by its
own sigma table nothing could pass (2 x 5 mm landmarks > 8 mm; 2 x 3 mm tape >
4 mm). So:

1. T comes from guard sensitivity: regenerate the CAD model at plus and minus
   delta on each fit-critical value and measure the change in shell-to-leg
   gap, then compare it with the liner's compliance (Phase 0, with Zane).
   Leg_Length is far less sensitive than widths: a 10 mm error moves a Club
   guard's height by about 7.6 mm (0.76 x 10).
2. Working placeholders until then: T = 15 mm on Leg_Length and 6 mm on
   fit-critical OW and OD.
3. Before Phase 1 ships, a **feasibility table** is computed from the
   calibrated sigmas: for each source mix (full sweep; sweep plus height;
   short sweep; one leg plus bilateral; covariates only), the predicted
   verdict. Required outcomes: a full sweep is `none`; a short sweep or
   bilateral leg is at worst `optional`; covariates only is `fail` (it is a
   preset, not custom). If the table does not come out that way, the
   tolerances or the capture change, not the bands.
4. **Typed manual values are user-attested, not gated by sigma.** They pass
   through with today's plausibility checks, so T4, the universal fallback,
   always stays orderable. The gate applies to scan-derived and model-filled
   values.

The card always names one concrete action, the one that most reduces fit
risk, picked by expected variance reduction over a short list: a 5-second
extra sweep of a named part ("Scan the inside of the leg again. 5 seconds."),
one tape measurement with the diagram (for example "Width at mark 2"), or the
player's height if it is missing. One step, never a list. Ordering is blocked
server-side (the checkout route reads the verdict), not only in the UI.


### 4.7 Where the line is (what the user is and is not told)

Liam's ask is a smooth experience that does not advertise what the scan
missed. That is right for the experience, and it holds as long as three
things stay true, because this is protective gear, often for kids:

1. **The gate is real.** Smoothness comes from the estimator and the
   refinement step, never from lowering the bar. A guard is printed only when
   the fit-critical values are inside tolerance.
2. **Copy never overclaims.** "Built from your scan" is true (the scan is the
   main input). "Measured to the millimetre" is not, and is never said.
3. **Ops can always see the truth.** The admin panel shows per-value
   provenance and sigma on every order, and the "guard does not fit" runbook
   (ROADMAP week 19) starts from them. Remakes are how we learn, and the
   estimator learns from them.

There is no quality grade on the reveal. A "Good" next to a possible "Great"
reads as second best and makes a parent ask "should we rescan?", which is the
failure feeling Liam wants to avoid. Every passing scan shows the same true
line, "Fitted to your scan". The "indicate to a degree" Liam asked for lives
in two places: the ghost leg filling in during capture, and the single card
of section 4.6 when the verdict asks for one.

---

## 5. Capture v3: one video sweep for every iPhone

### 5.1 What the user does

1. Sit, shorts above the knee, other leg moved aside. **Open decision
   (2026-11-11, Liam):** the earlier "foot flat, shin upright" pose bends
   the knee near 90 degrees, which hides the dip below the kneecap from
   slices along the shin and shortened Leg_Length by up to 15% on synthetic
   legs, so silhouette v4 makes a knee bent past about 60 degrees a retake.
   But with the thigh horizontal on a chair, knee bend is about 90 degrees
   minus the shin's lean from vertical, and the posture gate refuses a lean
   past 30 degrees (MAX_TILT_DEG; the math holds to 40,
   tests/test_silhouette_tilt.py). So no ordinary seated pose passes both.
   Candidates: standing with a helper (knee straight, shin upright); a high
   seat or bed edge with the leg reaching forward plus the tilt gate opened
   to 40 degrees; a knee landmark that does not depend on the dip (a
   later math change); or **Leg_Length from one tape number**, which a plain
   video needs for scale anyway (section 5.7): the scan then only finds the
   ankle, and the S1 to S4 slices at 20 to 80% of the typed length sit
   below where the thigh enters (87% of leg length at 90 degrees on the
   synthetic hinge), so a seated pose stays usable. **Built and proven
   2026-11-11 (e43035b), not wired:** `reconstruct_silhouette(...,
   leg_length_m=)` measures every S1 to S4 width and depth within 0.7% of
   a straight leg at up to 90 degrees of bend with the true length typed.
   Wiring still needed: an optional `leg_length_mm` in capture.json (or the
   manual payload), the handler call, a Leg_Length override in the measure
   step, and the manual-entry knee-point diagram. Until decided, the app's station copy ("foot flat,
   shin upright") leads to a bent-knee retake. Untested on a device.
   **Direction (2026-11-11, Liam): scan only, the user types and measures
   nothing.** The typed length stays a hidden fallback. First probe of a
   front-edge knee finder, on the synthetic hinged leg's truth solid (not yet
   through the silhouette reconstruction): the thigh of a bent knee enters
   the shin slices from behind, so the front edge alone keeps its dip. The
   front-edge minimum sat 7.5 mm below the true knee at 45, 60, 75 and 90
   degrees (about 2% of a 380 mm leg, inside the provisional 15 mm
   tolerance), while the full-width minimum drifted to 37.5 mm low at 90
   degrees. At 0 degrees the front edge found a false minimum lower down, so
   the rule would be: width dip when no thigh onset, front-edge dip when
   there is one. Caveats: the synthetic leg has no kneecap or patellar
   tendon, so the 7.5 mm bias is not anatomy; next steps are the same probe
   through the masks and dual-conic slices, the shin-thigh hinge as a second
   finder, and tape ground truth on real seated legs. Scale for in-app
   captures comes from ARKit world tracking (metric on every iPhone),
   accuracy unmeasured.
2. Hold the phone at shin height, about an arm's length away, pointing at the
   shin. The app finds the leg automatically (Vision body pose, as in da1b01b).
3. **Press record, keep the phone at shin height, and move it slowly round
   the front of the leg from one side to the other**, keeping it pointed at
   the shin. A horizontal arc, not up and down. About 8-12 seconds. A helper
   can walk further round; the flow is the same. The Get set screen shows a
   3-second looping demo of the motion, which does more than any sentence.
4. The app stops on its own when it has enough, or the user taps Done any time
   after the minimum (section 5.3).

It feels like taking a video because it is one: one continuous gesture, no
dots to hit. Internally it is ARKit frames, not a movie file.

Why this beats both earlier attempts:

- Versus the v2 sweep: no coverage requirement around the back. The front
  half-circle is reachable seated, and each view sees both edges of the leg.
- Versus 5 stations: no precise positioning, so no "move to the next dot"
  loop, and many more views (20-36 keyframes instead of 5) which both
  averages noise and lets the section shape be richer than an ellipse.

### 5.2 On the phone, per frame

The existing SilhouetteCaptureController already runs most of this; v3 makes
it continuous instead of per station.

1. ARKit world tracking (gravity aligned, metric) gives the camera pose.
   Frames with tracking not `normal` are skipped (as today).
2. Cheap checks every frame: angular speed, Laplacian sharpness, distance to
   the leg axis, tilt. These no longer block a shutter; they score frames.
3. **Keyframe selection:** keep a frame only if it is sharp, still enough, and
   at least about 6 degrees of azimuth from every kept frame (or replaces a
   worse one in the same bin). Cap at 36. This is what turns a messy video
   into a clean, spread set of views.
4. For each kept keyframe only (not every frame, for battery and heat):
   Vision foreground mask and body pose, then the same mask verdicts as today
   (notFound, cutOffSide, tooShort).
5. On LiDAR phones, the keyframe also stores the ARKit scene depth map
   (256x192, 16-bit) and its confidence map, masked to the leg.

### 5.3 Live feedback (the "indicate to a degree" part of capture)

The screen holds three things at most: the camera with the ghost leg, one
instruction, and (once earned) Done. That is the lesson of 602dbf1.

- **One instruction at a time**, in a solid stud brown block with yellow text
  at h3 size or larger (no blurred overlay). Directions are relative to the
  leg, never "left" or "right", because left and right flip between a seated
  self-scan and a parent facing a child, and an arrow on the ghost leg backs
  each one. Lines: "Point at the shin", "Move slowly round the leg", "Now
  round the other side", "Move closer", "Lower the phone to shin height", "Too
  dark. Turn on the light" (torch button inline). With a helper the copy says
  "the leg", never "your leg".
- **A ghost leg that fills in, and it is the progress indicator.** A flat
  yellow 3D shin, placed on the real leg in AR, starts as an outline and steps
  up in opacity where views have been collected (stepped opacity, no glow or
  bloom). It shows progress without ever saying "missing", and it makes the
  user want to sweep the part that is still faint. It is drawn from the
  azimuths covered, not from server results, so it is instant. No separate
  progress ring.
- **Auto-stop is the main way to finish**: when the on-device heuristic says
  the arc is enough (at least 12 keyframes spanning at least 120 degrees, both
  ends of the leg seen in at least 3 of them). A full-width, bottom-pinned
  Done appears only once a lower minimum is reached (8 keyframes, 90 degrees),
  never greyed out from the start. Both thresholds also require at least
one keyframe within about 20 degrees of a side view (90 degrees from the
front): without one, OD is not observed at all (section 4.4).
- **Haptics and voice carry the guidance**, text is the backup: at the ends of
  the arc a self-scanner cannot see the screen. Haptic tick on each keyframe
  kept, one success haptic at the finish, and an optional spoken instruction
  only when the instruction changes (the same call announces it to
  VoiceOver, throttled).
- Stuck for 20 seconds: the existing "Having trouble?" sheet with the most
  frequent failing check and "Enter measurements by hand".

**Lessons from the video harness (2026-11-11, docs/VIDEO-HARNESS.md).** Two
deliberately bad videos failed only on framing once the math stopped
treating a cut-off view as fatal (silhouette v2/v3). On the phone:

- **Knee end in frame is the check that matters.** Require the knee end with
  a little thigh above it inside the frame in at least 3 keyframes spread
  across the arc, for both auto-stop and Done. Copy: "Move the phone further
  back so the knee fits". Toes or foot off the frame need no warning.
- **Too close:** a live per-keyframe check of the leg mask touching the frame
  along the leg's sides, with "Move the phone further back" before the arc
  continues.
- **Credit keyframes by visible region:** a keyframe counts toward coverage
  only for the leg heights it shows inside the frame, so the ghost leg stays
  faint where the knee was never seen.
- **Bent knee (required, silhouette v4):** a knee bent past about 60 degrees
  is now a retake ("sit with your foot further forward"). The Get set
  screen and the live checks must ask for the foot forward before the sweep
  starts, or seated self-scans will fail late.
- **Phone orientation:** irrelevant to the math on the phone (ARKit gravity),
  but an upside-down hold shows up in the ghost-leg overlay.
- Body pose found no body in any close-up frame, so the on-device ankle and
  knee hints cannot rely on Vision joints at this distance; use the mask's
  width profile.

### 5.4 Photos stay on the phone

The silhouette math needs masks, poses, intrinsics and joints. It does not
need the photos. v3 uploads:

- masks (leg outlines as 8-bit grayscale PNG, the format png.py already
  decodes, values 0 or 255 so they compress to a few KB, downscaled to at
  most 1024 px on the long side: about 0.65-0.9 mm per pixel at 0.5-0.7 m,
  and the edge fit along each tangent recovers sub-pixel position),
- poses, intrinsics, joints, per-frame quality scores,
- depth maps on LiDAR phones (leg pixels only; everything else zeroed),
- **no JPEGs by default.**

Photos upload only with explicit, separate consent ("Help improve FORMS scans")
for the replay and training set, under the existing retention rules. Age is
self-reported and skippable, so the option is **off and not offered** when
the age band is unknown or under 18, until legal review (DESIGN.md 9.4)
delivers a guardian-consent flow. This is a real privacy upgrade
for minors' body data, a smaller upload (the "won't save" failure gets less
surface), and a line for the App Store privacy label and the marketing site.

Trade-off accepted: without photos the server cannot re-segment a bad mask.
Mask quality is therefore checked on the phone before a keyframe is kept, and
the consented photo set is how segmentation is improved over time.

### 5.5 Contract: capture.json v3 (method "sweep")

Lockstep change: Swift writer (forms-capture), TS validator
(apps/app/src/lib/upload.ts), Python validator (reconstruct/bundle.py), same
commit series, equivalent tests on both validators. v1 and v2 stay accepted
(replays and in-flight scans).

```json
{
  "format": "forms.photo-capture",
  "version": 3,
  "method": "sweep",
  "device": { "model": "iPhone17,3", "os": "26.1", "lidar": false },
  "floor_y": -0.42,
  "capture": {
    "mode": "solo",
    "anchor_world": [0.01, -0.18, -0.46],
    "front_azimuth_rad": 1.57,
    "coverage": 0.62,
    "finished_early": false
  },
  "images": [
    {
      "id": "000",
      "photo": null,
      "mask": "000.png",
      "depth": null,
      "depth_confidence": null,
      "timestamp": 12.034,
      "camera_to_world": [16 numbers, column major],
      "intrinsics": [fx, fy, cx, cy],
      "width": 1024,
      "height": 768,
      "tracking": "normal",
      "sharpness": 182.5,
      "azimuth_rad": 1.31,
      "joints": { "knee": [512.0, 140.2, 0.81], "ankle": [498.4, 690.0, 0.77] }
    }
  ]
}
```

Rules (both validators):

- 8 to 36 images. `id` is `^\d{3}$`, unique; `mask` is `<id>.png`;
  `photo` is `<id>.jpg` or null; `depth` and `depth_confidence` are
  `<id>.png` under `depth/` and `depth_conf/`, or null.
- No `leg` field: the leg is `scans.leg`, already set server-side, and a
  second copy could only disagree.
- `width`, `height`, intrinsics and joints refer to the mask. A consented
  photo may be larger; it carries its own size and the server never uses it
  for measurement, so the v2 rule that the photo and mask sizes match
  (bundle.py) applies to v2 only.
- `depth` must be null when `device.lidar` is false. 16-bit PNG, unsigned
  millimetres, at most 256x192; the confidence map is 8-bit, same size.
  Converted to meters exactly once, in the depth observation builder
  (shape/observe.py), the one place depth enters the meters-based geometry.
- Size caps: capture.json 1 MB, each mask 256 KB, each depth map 128 KB,
  each optional JPEG 2 MB, whole bundle 16 MB. Decompression caps from the
  PNG header, as png.py already does; a 16-bit decoder is added for depth.
- `station` is gone in v3; `azimuth_rad` (relative to front) replaces it and
  is advisory only: the server recomputes azimuth from the pose.

### 5.6 LiDAR phones (untested, designed to fail safe)

- Same flow and same bundle; `device.lidar` true and depth maps attached.
- Server: depth points on the leg become surface observations (section 4.4)
  and an independent check of ARKit scale. If depth and silhouette disagree
  beyond a threshold, depth is dropped for that scan and the event logged; the
  silhouette result still stands. So an untested sensor can only help.
- ObjectCapture (T1) stays in the code but leaves the default path: it needs a
  walk around the leg, which is the solo problem again. Decision for Liam
  (section 15).
- Trial: one borrowed LiDAR iPhone, five legs, compare depth-on vs depth-off
  against tape. Until then the depth channel is behind a remote flag.

### 5.7 Plain video, Android, web (later, same server)

- **Android:** ARCore gives the same metric poses and a depth API on many
  phones, so an Android writer produces the same capture.json v3. Android
  becomes a capture client, not a new pipeline, exactly as DESIGN.md section 5
  planned. Segmentation: ML Kit selfie or subject segmentation (license check).
- **Plain video upload (web, any phone, camera roll):** a movie file has no
  poses and no scale. It needs server-side structure from motion (COLMAP,
  BSD licensed) plus a scale reference: a sheet of A4 or Letter paper on the
  floor beside the foot (detected automatically), or the tape-measured leg
  length. Server-side segmentation would then need a permissively licensed
  model (never AGPL, SCAN-PLAN.md section 3). This is the hardest tier to
  make accurate; it comes last and only if demand shows up.
- **Tape measurements add real scale.** Everything a plain video yields is
  a ratio (OD/OW, widths relative to S3, Leg_Length relative to width). A
  single typed number per leg, Leg_Length from the floor to the knee crease
  or OW at one mark, fixes the one unknown scale factor, and the ratios
  carry it to all 25 values. **Measured 2026-11-11:** under the provisional
  noise and 6 mm tolerances the estimator's gate still says "required"
  after one tape Leg_Length (r about 1.1) and asks for one depth next, so
  plan on two numbers until calibration says otherwise. It is the cheapest
  scale reference there is (no paper detection, no LiDAR) and it is the
  same observation the estimator already takes from manual entry (section
  4.4). The local video harness (docs/VIDEO-HARNESS.md, 2026-11-11) reports
  ratios only for exactly this reason.

### 5.8 What happens to the existing tiers

| Tier | After v3 |
|---|---|
| T1 ObjectCapture (LiDAR) | Kept, off the default path. LiDAR phones use the sweep with depth. |
| T2 helper 3D photo sweep + Mac photogrammetry | Kept for replays and as a fallback while v3 proves itself; the helper uses the v3 sweep by default. Retire once v3 matches it on the accuracy log, which also retires the Mac worker requirement. |
| T3 5-station silhouette | Superseded by the v3 sweep (which is the same math with more, unconstrained views). Bundle v2 stays parseable. |
| T4 manual and adjust | Kept, and better: inner values come from the leg model, and manual values are observations in the same estimator (so a scan plus one tape number fuse). |
| Presets S/M/L | Unchanged in mechanism; the leg model makes them visual (section 7.5). |

---

## 6. Server changes

### 6.1 Silhouette math v3

Today: an ellipse per 2 mm slice from about 10 tangent lines (5 views). With
20-36 views there are 40-72 tangent lines per slice, enough for:

- **A support-function contour instead of an ellipse.** For a convex section,
  every tangent line gives the support function h(theta) at its normal
  direction. Keep the existing dual-conic ellipse as the base and fit a
  Fourier correction of orders 3-4 on top (with a convexity check) by linear
  least squares. The ellipse is not a special case of the series: its
  support function is sqrt(n^T S n), not a trig polynomial. So the existing
  ellipse tests still apply, within tolerance. OW and OD come straight from
  h; the harmonics feed the leg model's shape coefficients.
- **Robust per-view weights** from residuals (Huber), replacing the single
  outlier pass, and the existing per-view pose refinement kept.
- **Azimuth-aware uncertainty:** each slice's covariance from the fit, so OD
  from a narrow sweep is honestly less certain than OW.
- The axis triangulation, landmark rule and quality gates stay; the gates that
  are about coverage (span under 120 degrees, fewer than 3 views) become
  inputs to sigma instead of hard failures, except where the data is truly
  unusable (no consistent leg, scale untrustworthy).

### 6.2 New package: forms_pipeline/shape/

```
shape/
  model.py        leg state vector, contour from (w, d, a, m, s), the 25-value projection
  prior.py        load and validate the versioned prior data file; mu(z), Sigma
  observe.py      per-source observation builders (silhouette, depth, mesh, manual, covariates)
  fuse.py         Gaussian conditioning plus Gauss-Newton; returns posterior mean and covariance
  gate.py         fit-critical set, per-product tolerances, verdict, best next action
  legmodel.py     posterior mean -> leg model rings (the 3D preview contract, section 7.2)
  priors/         prior data files, e.g. prior-0.1.0.json
```

All pure. Reconstruct and extraction keep their jobs (raw data to
observations); fusion owns the step from observations to answers.

### 6.3 Where it runs in the state machine

No new pipeline states. The measuring handler today reads a mesh and runs
extraction. In v3 it:

1. collects observations from whatever the scan has: the silhouette or
   photogrammetry result, depth, manual values, the player context, and, for
   a pair, the other leg's stored observations (read only, never written),
2. fuses, gates, and writes **only its own scan's rows**: the measurements
   row (the 25 values, as today), the quality row, and the leg model,
3. completes the job as today. A gate "fail" is a typed, non-retriable
   GateViolationError with a user-facing reason; numerical failure is the
   typed EstimatorError (section 4.3).

The other leg of a pair is found server-side by `pair_id` **and**
`storage_user_id` together. pair_id is generated by the client (0010), so
matching on it alone could pull another user's leg into a fusion.

The reconstructing step for silhouette scans writes observations (a small
JSON artifact) instead of, or as well as, a lofted mesh. Keeping the lofted
mesh for one release lets the old extraction run side by side on every scan,
which is the cheapest regression check there is.

Late inputs: the player answers age and height during the processing wait
(section 8), so on the fast silhouette path they can arrive after the first
fusion. Saving them enqueues a fresh measure job for that scan through a new
RPC (section 9: the existing enqueue RPC accepts only `uploaded` scans, and
this scan is already `ready`). The job is cheap: observations are already
stored, no reconstruction. The reveal waits at most a couple of seconds for it
and otherwise shows the first result, then updates in place.

Pair order: when the first leg (A) finishes before the second (B), A is
measured alone. When B completes, B's job writes only B's rows. It then
enqueues a fresh measure job for A, through the same RPC, so A is re-fused
with B's observations by A's own job, under A's one-active-measure-job index
(0008). Two rules keep this safe:

- **Skip conditions:** no re-fusion of A when A has a manual or adjusted row,
  or A is on a paid order. A user's own numbers and a paid order's CAD input
  never change behind their back.
- **No silent override through created_at.** Today `get_measurements` reads
  the newest validated row by created_at, and the upsert resets created_at
  (runner.py), so any re-run would outrank a later manual adjustment. v3 adds
  an explicit `superseded_at` and reads the row the user last accepted,
  never just the newest write.

A failed B job therefore cannot touch A, and A and B never race on one row.
Idempotent by construction: re-running A's job with the same inputs lands on
the same rows.

The order snapshots its inputs: on the paid transition, the 25 values,
extraction_version and the leg model reference are copied onto the order
(migration 0021). The CAD job reads the snapshot, so nothing that happens to
the scan after payment can change what is printed. No snapshot exists today;
this closes that gap for v2 scans too.

### 6.4 Versions on every row

Measurements stay keyed (scan_id, extraction_version), and DESIGN.md
section 6 says never mutate, always version. So the estimator and prior
versions are **folded into extraction_version** (for example
`3.0.0+p0.1.0`), not stored beside it: a prior bump then creates a new,
comparable row instead of overwriting the old one. v2 rows remain history.

**Backfill.** Phase 2 assumes every scan has a leg model. An operator script
re-fuses existing scans in pages (keyset pagination, bounded batch size, one
job per scan through the queue, never a bulk loop in one transaction). For
scans whose raw meshes or photos retention has already deleted, the fusion
uses the stored 25 values themselves as observations (tape-like sigma), so
every scan gets a leg model.

---

## 6a. The CAD model: verified meaning, and license to improve it

### 6a.1 Liam's standing permission (2026-11-10)

Liam: the Onshape model "isn't a limitation"; if a change to it would make
the scans or the guards better, make it, on a copy. Rules that follow from
that:

1. Work only on copies. Never edit the original MVP document or the
   pipeline's template copy. A private workbench copy, "FORMS model
   workbench (Claude, copy of pipeline template)", exists for this; it
   holds only synthetic values, never a real person's measurements.
2. Every copy is created private, and checked; a copy that comes back public
   is deleted at once (the same rule as the pipeline's job documents).
3. A model change is adopted only after: a regeneration sweep across child
   to large-adult legs with no failing features, a bounding-box sanity
   check, and, for anything that changes fit, a test print. The pipeline
   switches to an improved copy by changing `ONSHAPE_DOCUMENT_ID` and friends
   in `.env`, which Liam does after reviewing the change.
4. Changes that add, remove or rename variables are schema changes (a
   versioned lockstep event across TS, Python, the model and DESIGN.md), not
   model tweaks. Zane is told about every adopted change.

### 6a.2 What the 25 variables actually mean (read from the model)

Read through the API from the workbench copy:

- Planes 1-4 sit at Leg_Length x 0.2, 0.4, 0.6, 0.8 (confirms the slices).
- Each slice is one sketch holding one open interpolated spline through
  four points, measured in the slice plane from a fixed reference at (0, 0),
  the shin crest:

  | Point | Position | S1 at today's placeholder values |
  |---|---|---|
  | inner calf | (-ICW, -ICD) | (-25, -12) mm |
  | inner shin | (-ISW, -ISD) | (-15, -6) mm |
  | shin crest | (0, 0), fixed | |
  | outer | (+OW, -OD) | (+30, -10) mm |

- Loft 1 lofts the four splines into the guard's inner surface, from S1 to
  S4. An offset surface adds EVA_Thickness + Fit_Clearance. A thicken adds
  Shell_Thickness (PETG), followed by edge fillets and a flat ankle landing
  for the P1S print.

So **widths say how far round the guard reaches on each side of the crest,
and depths say how far back the leg surface falls away at those points.**
They are not full leg widths and depths. The guard covers S1 to S4, which is
0.2 to 0.8 of Leg_Length, not the 0.12 to 0.88 the 2D preview assumes.

Evidence it is right: the guard Liam printed (149 mm tall, 23.7 mm deep, fit
well) matches this model at about Leg_Length 250 with small crest-relative
offsets. A regeneration sweep on the workbench, with values computed this way
from synthetic leg sections, built cleanly for a child (guard 60 x 139 x 21
mm), an adult (81 x 218 x 26) and a large adult (97 x 260 x 30).

### 6a.3 What this changes in the scan work

1. **Leg values must not go to the model unconverted.** Sent as is, the
   leg's full widths would build a guard that wraps almost to the calf.
   Resolved by schema 1.1.0 (2026-11-10), which turned out not to need new
   meanings for the stored values: they stay leg measurements, because the
   app's preview, manual entry, the measurement table and the admin all use
   them that way. Instead the CAD descriptor gained a required `profile`,
   and `forms_pipeline/cad/profile.py` converts leg values into the model's
   crest-relative points in one place (DESIGN.md 7a.2 and 12.2). v1 treats
   each section as an ellipse; the leg model (section 4) later supplies the
   real contour through the same boundary.
2. **The scan's real job gets smaller and clearer.** Per slice it must find
   the shin crest and measure how far the leg surface falls back at given
   distances to each side of it. That is the front of the leg, the part
   every view of the sweep sees best. The back of the calf never enters the
   model. That makes the solo sweep a better fit for the problem than any
   earlier capture.
3. **Widths are partly a design choice.** How far the guard wraps (ISW, ICW,
   OW) is what makes a guard a Pro or a Junior Max. So the pipeline sets the
   widths from the product (a wrap fraction of the leg's section, carried by
   the CAD descriptor), and the leg model supplies the depths at those
   widths. One model then serves every tier, and the depths, the true
   measurements, are what the estimator's confidence and the fit gate are
   about.
4. **The leg model (section 7.2) must locate the crest per slice.** Its
   section contours already allow it; the crest becomes an explicit output
   and the frame's origin at each height.
5. **Fit_Clearance already exists** in the model. Raising it slightly when
   confidence is lower needs no model change, only a per-order value
   (decision 6 in section 15).

### 6a.4 Model improvements worth testing on the workbench (none adopted yet)

| Idea | Why it would help | Cost |
|---|---|---|
| Per-slice crest offset (the tibial crest is not perfectly straight along the leg axis) | The model assumes all four (0, 0) references lie on one straight line; a curved crest misplaces the loft by a few mm | New variables: schema change, so only if scans show the offset matters |
| Coverage extensions below S1 and above S4 | Junior Max wants more coverage than 0.2 to 0.8 of the leg | New variables or a per-model constant; product decision |
| More points per slice (a five-point spline on the flat inner face of the tibia) | Better match to the shin's real shape where the guard bears | Schema change; only after the sweep proves it can measure them |
| Regeneration guard rails (minimum spline spacing, convexity) | Bad inputs fail loudly in Onshape instead of making odd shells | Model only, no schema change |

Only the last one is a pure model change. The rest wait for evidence from
real scans, per the rules in 6a.1.

---

## 7. The 3D preview: their leg, their guard, spinning

### 7.1 What the user sees

After processing, the reveal screen. First view, above the fold:

1. **The stage:** full-bleed stud brown, the top ~60% of the screen (the
   FitPreview precedent: graphics on brown, content on yellow below). Their
   leg appears with a quick scale-up (under 200 ms), then one half turn of
   about 1.2 s, then stops and waits for touch. No slow fades or floating.
2. The guard drops onto the shin in about 250 ms with a decisive ease and one
   haptic.
3. The coverage label on the stage, number first: "76%" large in Outfit, with
   the caption "of your shin, 268 mm tall", bracketed against the band on the
   leg. Not repeated below the model.
4. The guard model switcher (Pro, Club, Junior Max, where purchasable). The
   band animates as the model changes.
5. "Fitted to your scan", one line.
6. The bottom-pinned primary action: "Order this guard".

Interaction: drag to orbit, pinch to zoom, double tap to reset, plus "Front"
and "Side" view buttons (segmented control) so VoiceOver users and anyone who
does not want to orbit get the useful angles. Left and right leg toggle when
it is a pair.

Below the fold, one grouped list of tappable rows (not a stack of toggles):

- **Measurements:** draws the four marks as yellow hairline rings on the leg
  with their widths, the same numbers as the measurement table, in place.
- **Compare with a stock size** (section 7.5).
- **Adjust measurements:** the existing adjust flow; on return the worker
  re-fuses (seconds) and the model updates when the new leg model arrives.

Material and lighting: leg matte brown 100 (#C0A965), guard bright brick
(#E0513F; brick 500 sinks into brown), bands and rings as yellow hairlines.
One key light, no specular gloss or environment reflections, a faint
brown-on-brown contact shadow. A neutral, non-skin leg reads as a precise
model, avoids the uncanny, and is inclusive. If the printed guard's real
colour differs from bright brick, show the true colour instead (check with
the print partner). Colours come from src/theme/tokens.ts, never raw hex in
components.

Before the server answers, the processing screen shows the ghost leg from the
capture, turning, with "Shaping your guard". This wait is also where the
optional player questions are asked (section 8). The reveal then replaces the
ghost with the real model, which is the moment of "this is mine".

### 7.2 Contract: the leg model (forms.leg-model v1)

New shared contract, mirrored validators in packages/shared (TS) and
forms_pipeline/shape (Python), same commit, equivalent tests.

```json
{
  "format": "forms.leg-model",
  "version": 1,
  "leg": "L",
  "units": "mm",
  "estimator_version": "0.1.0",
  "prior_version": "0.1.0",
  "leg_length_mm": 368.2,
  "frame": "right-handed: x toward the player's right, y anterior, z up from the bottom of the ankle",
  "rings": [
    { "t": 0.0, "center": [0.0, 0.0], "points": [[x, y], "... 48 points, counter-clockwise from +x"] },
    "... 21 rings, t = 0.00, 0.05, ..., 1.00"
  ],
  "fit_check": "none"
}
```

- One right-handed frame for both legs (x toward the player's right), so the
  app never mirrors anything; medial and lateral are derived from `leg`.
  A per-leg "x lateral" frame would be left-handed for left legs, a classic
  silent-mirror bug.
- About 21 x 48 x 2 numbers rounded to 0.1 mm: under 25 KB as JSON.
- `guards` (same contract) carries one shell per purchasable template, and
  `compare` the nearest stock preset's shell plus its per-ring stand-off
  distances, both as ring lists in the same frame (section 7.3). The app
  only triangulates rings it is given.
- Generated from the posterior mean, so it is exactly the leg the 25 values
  describe; the app never derives geometry from raw scan data.
- `fit_check` is one of `none`, `optional`, `required` (the gate verdict of
  section 4.6, plus the action to offer when not `none`), the only confidence
  information that reaches the client. Per-value sigma stays server-side and
  admin-only.
- Foot and knee caps are drawn by the app as generic, scaled shapes for a
  natural look, visibly lower-detail than the shin. They are cosmetic and
  never measured from.

### 7.3 The guard on the leg

Pre-purchase there is no Onshape geometry (CAD jobs start only on the paid
transition, DESIGN.md section 6 and migration 0016; fitPreview.ts states the
same rule). So:

- **Before purchase:** an approximate shell generated **by the worker**, in
  forms_pipeline/shape/ next to the leg model, and shipped in the leg-model
  contract: take each ring between the template's bottom and top fractions,
  keep the front arc given by its wrap fraction, offset outward by clearance
  plus liner (inner surface) and plus shell (outer surface), loft, round the
  rim. The worker owns it because apps/app/CLAUDE.md says the app never
  interprets geometry; the app turns rings into triangles and nothing else.
  Pure Python, unit tested (no NaN, constant thickness, band height equals
  (top - bottom) x L, inner surface never inside the leg). Labelled everywhere
  as a preview, as the 2D one is today. (Today's 2D fitPreview.ts already
  computes geometry in the app; it stays as the fallback and is not grown.)
- **After purchase:** the real STL from the CAD job, decimated to a small GLB
  by the worker (trimesh) and stored next to the STL, so "your guard" in order
  history is the exact made shape.
- **After the code-CAD port (DESIGN.md section 7):** the exact guard is cheap
  to generate pre-purchase, and the approximate shell retires.

The template coverage numbers for Pro and Junior Max are placeholders today
(fitPreview.ts says so); the 3D view must keep showing them as illustrative
until those CAD models exist.

### 7.4 Size as a percent of the leg, on the leg

Guard templates are already defined as fractions of Leg_Length (Club 0.2 to
0.8, the model's S1 to S4). On the model:

- The coverage band is drawn on the leg itself, with a bracket and the label
  of section 7.1: "76%" large, "of your shin, 268 mm tall" as the caption.
- Switching Pro / Club / Junior Max animates the band: the Pro sits low and
  short, Junior Max climbs toward the knee. This makes the product line
  legible in one gesture.
- If sizes are sold as percent steps (DESIGN.md 12.7 floats "percentage steps
  around a base"), each size is a band on the same leg, so the user sees which
  one covers what. The same rendering serves custom and presets.

### 7.5 Custom vs stock, on their leg (the sales argument)

"Compare with a stock size" places the nearest preset (S, M or L, picked from
their Leg_Length) on the same leg model. The custom guard shows no marking;
the stock guard shows bright brick patches (one hue, inside the palette)
where it stands off the shin, and a sentence says the same thing so colour is
never the only signal: "A stock M sits up to 9 mm off your shin." This is the
single most persuasive screen in the product, and it is cheap once the leg
model and the shell generator exist.
Needs the preset value sets (DESIGN.md 7a.3), which are data, not code.

### 7.6 Tech choice

- **three.js through @react-three/fiber with expo-gl** on iOS and Android, and
  the same component on web through the DOM renderer, so the viewer is one
  codebase on all three platforms, like the rest of apps/app. Exact versions
  pinned after checking compatibility with Expo 57, React 19.2 and RN 0.86 at
  implementation time (new dependencies are named in the agent brief, never
  added ad hoc).
- Geometry built from the rings in a pure TS module (rings to indexed
  BufferGeometry data, guard shell from rings plus template), tested in
  Vitest without a GL context. The React component is a thin shell.
- Lazy loaded: the viewer and three.js load only on the reveal and scan
  screens, so the rest of the app and the web bundle stay small.
- Fallbacks: no GL context or low memory: the existing 2D FitPreview (kept,
  not deleted). Reduced motion keeps the 3D view, static: no turn, no drop,
  no band animation.
- Accessibility: the stage has an accessibility label stating the guard
  model, the coverage percent and the height (as FitPreview does today); the
  Front and Side buttons replace orbiting for VoiceOver; every number shown
  in 3D is also in the measurement table.
- Performance budget: under 10k triangles for leg plus guard, 60 fps on an
  iPhone 12, first render under 300 ms after data arrives.
- Later, cheap and impressive: **AR try-on on iOS.** At the end of the
  capture the ARKit session still knows where the leg axis is; when the leg
  model arrives, the guard can be placed on the real leg in the camera view.
  Stretch goal, after the core viewer.

---

## 8. The end-to-end flow, screen by screen

1. **Get set:** which leg (the only question before the scan), the 3-second
   looping demo of the sweep, one illustration of the seated pose, and three
   short lines. Torch tip if the room reads dark. Nothing else stands between
   the user and the scan: the start of the flow is where people drop off.
2. **Sweep:** sections 5.1 and 5.3. One instruction, the ghost leg as
   progress, auto-stop.
3. **Second leg?** "Scan the other leg for the closest fit, or use this one
   for both." Default: scan it (it is 10 seconds), but both choices work,
   through the bilateral correlation.
4. **Shaping your guard:** the ghost leg turning; typical wait a few seconds
   on the silhouette path. The otherwise dead time asks the two optional
   player questions, age band (under 8, 8-12, 13-17, adult) and height, with
   one line: "Age and height help us shape the guard." Skipping costs nothing
   visible (parents often do not know a child's height). Answers are saved to
   the player so they are asked once, not every scan. No name field: it is
   minors' data for a small piece of copy. Push notification if they leave.
5. **Reveal:** section 7.1. "Fitted to your scan", guard switcher, coverage
   on the leg, order.
6. **The check card** (only when `fit_check` is `optional` or `required`):
   one card, one named action, then back to the reveal with the model updated.
7. **Order:** existing checkout; the order snapshots the measurement row and
   estimator and prior versions it was priced and built from.

Error copy follows SCAN-PLAN.md section 6 unchanged: one instruction, a named
fix, never a dead end, manual entry always reachable.

---

## 9. Data model and contracts

Reserved migration numbers (one per workstream, claimed before work starts,
per the shared-worktree rule):

| Migration | Contents |
|---|---|
| 0018_measurement_quality.sql | A separate `measurement_quality` table (measurement id, per-key provenance and sigma, verdict), RLS enabled with **no client policy** (admin and worker only), the house pattern. RLS cannot hide one column of `measurements`, and a column grant would be easy to undo by accident. Plus `measurements.superseded_at` and the "row the user accepted" read rule (section 6.3). |
| 0019_leg_models.sql | `leg_models` (scan_id, extraction_version, model jsonb, created_at), unique (scan_id, extraction_version), RLS owner SELECT only, no client writes (consistent with 0017), cascade on scan delete, included in data export and account deletion. |
| 0020_scan_context.sql | Its own `scan_context` table, **not columns on scans**: "scans: update own" (0017) lets the owner update scan columns directly, which would bypass validation. Fields: `age_band` (check against the enum), `stature_mm` (range check 600-2200), `improve_opt_in` (bool, section 4.2). No sex field, no date of birth, no free text. Written only by a SECURITY DEFINER RPC that re-checks ownership and validates. Deleted on account deletion even when measurements are kept as order records. The device prefills the last answers so they are asked once; a players entity (a parent with two kids) is a later product decision. |
| 0021_refuse_and_snapshot.sql | (a) `request_scan_refusion(scan_id)`: SECURITY DEFINER, owner-checked, accepts `ready` scans, refuses when the scan has a manual or adjusted row or is on a paid order, and relies on the one-active-measure index for concurrency. Used by late player answers, the check card and pair completion. (b) Order measurement snapshot: the 25 values, extraction_version and leg model id copied onto the order at the paid transition; the CAD job reads only the snapshot. |

**Status 2026-11-11:** 0018, 0019 and 0021 are written and tested
(supabase/tests/estimator_data_checks.sql), unwired. Deviations: the
snapshot is per leg (orders.snapshot_left and snapshot_right,
forms.order-leg-snapshot v1, plus snapshot_at), not one shared set, because
the legs of a pair can differ in version and source; remakes copy the
original's leg snapshot. request_scan_refusion refuses any manual row (SQL
cannot yet tell adjusted from manual), deleted scans and erased raw captures.
A paid transition for a scan with no measurements row is still refused by
the 0016 CAD trigger (unchanged). 0020 remains reserved.

Manual payload change (lockstep, listed so it is not missed): today the app
derives all 16 inner values and the worker requires exactly the 25 keys
(runner.py). In v3 the manual RPC accepts the 9 typed keys, and the worker
fills the 16 from the model while passing the 9 through unchanged. That
touches apps/app/src/lib/manualSubmit.ts and manualMeasurements.ts, the 0014
RPC (a new version in 0021 or its own migration, reserved when Phase 1
starts), and the worker's manual handler, with tests on each side.

New or changed shared contracts (packages/shared, mirrored in Python):

- `forms.leg-model` v1 (section 7.2): TS type plus validator; Python dataclass
  plus validator; equivalent tests.
- `MeasurementQuality` (server and admin only): per key `{ source:
  "observed" | "inferred" | "manual" | "adjusted", sigma_mm }` plus `verdict`.
  The source enum lives in packages/shared like the other enums.
- capture.json v3 (section 5.5): TS validator in upload.ts, Python in
  bundle.py, Swift writer.
- `AGE_BANDS` enum in packages/shared.
- The 25-variable schema: **unchanged**. Values remain plain mm numbers.

Optional, for Zane: if the CAD model should widen Fit_Clearance when
confidence is lower, that is a per-order CAD parameter outside the 25, passed
through the CAD descriptor layer. Not in v1; a decision for later (section 15).

---

## 10. Security and privacy review

| Item | How this plan handles it |
|---|---|
| RLS on every table | leg_models owner SELECT only; measurement_quality no client policy; scan_context written only through the RPC; pair lookups match pair_id and storage_user_id server-side. SQL checks extended in CI. |
| Minors' body data | Photos no longer uploaded by default; masks downscaled; depth only on leg pixels; leg model is measurement-level detail. Retention: masks, depth maps and depth confidence maps are named explicitly in the retention sweep (0015 covers photo bundles; v3 adds the `depth/` and `depth_conf/` prefixes and its tests); leg model kept with measurements. Data export and account deletion cover leg_models and scan_context. |
| Player profile | Age band, not date of birth. No name field, no sex field. Own table, RPC-written, deleted on account deletion. |
| Untrusted uploads | v3 validators: counts, names, sizes, PNG decompression caps, rigid-transform check, joint bounds, depth ranges. Fail the job, never the worker. |
| No secrets client-side | No new client secrets; the viewer reads the user's own rows under their session. |
| Analytics | PostHog events carry counts and verdicts only: sweep_started, keyframes_kept, sweep_finished{span_bucket}, fit_check{none/optional/required/fail}, check_action{kind}, viewer_opened, compare_opened. Never values, sigma, poses or models. |
| Consent for training data | Separate opt-in, recorded per scan, revocable. Off and not offered when the age band is unknown or under 18 until a legal-reviewed guardian flow exists. The prior refit reads only opted-in rows. |
| Dependencies | three.js, react-three-fiber, expo-gl pinned exact; licenses checked (MIT). No AGPL anywhere in the scan path. |
| Prior data | Derived from public anthropometric tables and, later, consented de-identified measurements only. The prior file holds statistics, never individual records. |

---

## 11. Testing

| Layer | Tests that ship with the code |
|---|---|
| shape/model.py | contour from parameters is convex and closed; the 25-value projection matches measure.py's definitions on the same contour; round-trip on synthetic legs. |
| shape/fuse.py | full synthetic observations recover truth within 1%; dropping any one source widens sigma and keeps the mean within 2 sigma of truth; missing top 20% of the leg; missing all depth; one-sided sweep; conflicting sources; degenerate inputs raise typed errors. |
| shape/prior.py | prior file schema validation; version mismatch refused; covariates absent vs present. |
| shape/gate.py | pass, marginal and fail cases per product tolerance; the best next action is the one with the largest variance reduction. |
| silhouette v3 | the existing synthetic suites plus: 36 views over 180 degrees, 12 views over 90 degrees, a non-elliptic section (flat medial face) recovered within tolerance, noisy masks, drifting poses. |
| bundle v3 | both validators: valid bundle, each violation, size caps, depth present without LiDAR, v1 and v2 still accepted. |
| leg model contract | both validators with equivalent cases; Python output validates in TS and vice versa (a shared fixture file). |
| app geometry | rings to geometry (vertex and index counts, normals), guard shell invariants (section 7.3), coverage label math. |
| app flow | capture flow state machine for the sweep, check card routing, pair "use for both". |
| replay | every real attempt recorded; replay diff table (old vs new extraction) before each release. |
| ground truth | the accuracy log, section 13 Phase 0. |

---

## 12. Metrics that decide when it is good enough

- **Accuracy (the ship gate, unchanged):** on 10 tape-measured legs, at least 8
  within targets, none worse than 8% on any OW/OD. Reported separately for:
  full sweep, short sweep, sweep plus height, manual only, prior only (as a
  baseline the scan must clearly beat).
- **Calibration:** across those legs, about 95% of true values inside the
  posterior mean plus or minus 2 sigma. If sigma lies, the gate lies.
- **Funnel:** sweep started to scan ready rate, check-card rate (target under
  20%), fail rate, time from start to reveal.
- **Fit outcomes:** remake rate and "does not fit" reports per verdict and per
  estimator version, fed back into the prior.

---

## 13. Phased delivery

Ordered so each phase ships value alone and the riskiest assumption is
tested first. Agent briefs follow docs/OPERATING-PROCEDURE.md step 3 (seven parts, pinned
contracts, reserved paths).

### Phase 0: ground truth and the real round-trip (mostly Liam)

The ROADMAP Month 1 gate is still red, and building ahead against fakes is
the pattern this repo has already repeated once (ROADMAP section 14). Phase 0
closes it before any estimator code is trusted:

- Fix the "won't save" upload failure from the dev flow logs (blocks every
  real test). Code: Sonnet-tier, apps/app upload path, after the device log.
- **Schema 1.1.0 and the CAD profile conversion** (section 6a.3 item 1):
  done 2026-11-10. The wrap fractions are provisional until a print made
  through the automated path is checked on a real leg.
- The printed guard (done by hand, 2026-11-10, fit well): record the exact
  variable values used and tape-measure that leg at 20/40/60/80%. Comparing
  the two answers what OW/OD mean in the model, since the template still
  holds placeholder-scale values (S1_OW 30 mm against a real 60-75 mm).
- One real leg all the way through the automated path: scan, measure,
  Onshape API round-trip on the template copy, STL, printed guard.
- The Zane walkthrough (DESIGN.md 12.2): what ISW/ISD/ICW/ICD mean, and the
  guard sensitivity study that sets the gate tolerances (section 4.6).
- Run T3 and manual on 5 legs (family), tape-measure, record with
  forms-replay, fill docs/accuracy-log.md. Human-only for the legs.
- Output: real noise numbers for silhouettes, Vision joints and tape (section
  4.4) and real tolerances (section 4.6).
- Gate: one guard printed through the automated path, the OW/OD semantics
  settled against the hand-printed guard, the replay set exists, and the
  noise numbers and tolerances are written down.

### Phase 0.5: the sweep spike (days, not weeks)

The capture is what Liam called poor, so the cheapest capture win comes
first. silhouette.py already accepts N views; only the 12-view cap in
bundle.py (MAX_SILHOUETTE_IMAGES) and the fixed stations stand in the way.

- Swift: keep the existing per-frame checks, drop the stations, keep
  keyframes by azimuth spacing (section 5.2), up to 24, inside the existing v2
  bundle with `station` relaxed. Behind a dev flag.
- Python: raise the cap behind the same flag; no math changes.
- Gate: on the Phase 0 legs, the spike's completion rate and accuracy against
  T3. If it already wins, Phase 3 is polish; if not, we learn why before
  writing the estimator around it.

### Phase 1: the estimator (server only, invisible to users)

**Split 2026-11-11 (forms-architect review, docs/ESTIMATOR-V1.md).**
Phase 1a: the pure shape/ package, unwired, plus the forms.leg-model v1 and
forms.measurement-quality v1 contracts with shared fixtures. v1 state is log L
plus log OW and log OD at 21 heights; anterior offset, medial share, shape
harmonics, Gauss-Newton, bilateral and guard shells are deferred, and
evidence comes from mesh sections. Phase 1b, after Phase 0 is green: runner
wiring, migrations 0018, 0019 and 0021, the manual payload change, the folded
extraction_version (`est-<estimator>+p<prior>`), the order snapshot and the
DESIGN.md section 6 rewrite, reviewed as one security surface. The list below
is the original whole-phase scope.

- forms_pipeline/shape/ as in 6.2: nuisance states, bootstrap prior, fusion,
  typed EstimatorError, gate, leg model and guard shells.
- The feasibility table (section 4.6) computed from the Phase 0 sigmas and
  checked against the required outcomes before anything ships.
- Migrations 0018, 0019 and 0021; shared contracts for the leg model and
  quality; the manual payload change (section 9); extraction_version with
  folded estimator and prior versions; the paginated backfill.
- The measuring handler writes the new rows; old extraction still runs side
  by side for a release.
- Agents: one strongest-tier agent for shape/ (new math); one strongest-tier
  agent for the shared contracts, migrations and RPCs (contract plus security
  surface); the orchestrator integrates. forms-architect reviews the Phase 1
  brief, because it changes DESIGN.md section 6.
- Gate: synthetic suites green, Phase 0 legs re-run through the estimator,
  calibration check passes (section 12), manual-only accuracy no worse than
  today, inner values unchanged until the Zane walkthrough says otherwise.

### Phase 2: the 3D viewer (app, ships even with today's capture)

- Viewer component, a pure rings-to-triangles module (the shells come from
  the worker), reveal screen, coverage band, guard switcher, measurement
  rings, Front and Side buttons, 2D fallback. Starts with a one-day spike on
  expo-gl and react-three-fiber under Expo 57 (risk 6).
- Works for every existing scan, including manual entries, because the leg
  model comes from the estimator. This is the first thing users see change.
- Agents: forms-designer first (reveal screen, material, motion, copy), then
  a strongest-tier agent for geometry plus viewer; Sonnet for screen wiring.
- Gate: performance budget met on a real iPhone; web build renders; designer
  sign-off.

### Phase 3: capture v3, the sweep (iOS)

- Swift: continuous capture, keyframe selection, per-keyframe Vision, masks
  downscaled, no JPEGs by default, ghost leg as progress, auto-stop, single
  instruction. Bundle v3 writer.
- TS and Python v3 validators (lockstep), silhouette math v3 (support
  function, robust weights, per-slice covariance).
- Player profile screen and migration 0020; "use this leg for both".
- Agents: strongest tier for the Swift capture and the silhouette math (two
  agents, two workspaces, pinned bundle v3 text in both prompts); Sonnet for
  validators mirroring an existing pattern; forms-designer for the capture UI.
- Gate: on the Phase 0 legs, the sweep beats T3 on the accuracy log and the
  sweep completion rate beats T3 on device.

### Phase 4: the refine step and the gate in production

- The check card (section 4.6) with the best-next-action logic, enforced in checkout; admin panel shows
  provenance and sigma per order; runbook "does not fit" path uses them.
- Gate: check-card rate under 20% on beta users; zero prints with a failing gate.

### Phase 5: LiDAR depth, compare-with-stock, AR try-on

- Depth channel behind a flag until the borrowed-phone trial; presets as
  data plus the comparison heatmap; AR try-on as a stretch.

### Phase 6: the flywheel and other platforms

- Refit the prior from consented scans (operator script, versioned).
- Android ARCore writer (same bundle). Plain-video upload with a paper scale
  reference only if demand appears.

Relation to ROADMAP.md: the calendar there has the App Store submission this
week. The physical half of its Month 1 gate is now green (a hand-made guard
printed and fit), but the automated half is not, and this plan puts it
inside Phase 0. The calendar from
Month 4 on is therefore stale now, not at Phase 1. Re-dating it is a
sequencing decision for Liam (section 15) and lands in ROADMAP.md as soon as
it is made.

---

## 14. Risks

1. **The prior is wrong for kids.** Adult anthropometry does not shrink
   linearly. Mitigation: wide variances for youth, age band as a covariate,
   real youth legs in Phase 0, presets for the youngest.
2. **Sigma is miscalibrated.** An overconfident estimator passes bad legs
   through the gate. Mitigation: the calibration metric in section 12 is a
   ship gate, not a nice-to-have.
3. **Vision masks on low contrast** (skin against a similar floor or wall).
   Mitigation: on-device mask checks per keyframe, torch, the consented photo
   set to improve segmentation, a permissively licensed segmenter if Vision
   is not enough.
4. **Continuous capture heat and battery.** Mitigation: Vision only on
   keyframes, about a 12-second capture, measured on an iPhone 12 class
   device.
5. **The inner-dimension meaning in Zane's model** (DESIGN.md 12.2). The leg
   model makes ISW/ICW better grounded than a symmetric split, but the
   walkthrough still decides what they must mean.
6. **3D in Expo** (expo-gl and react-three-fiber compatibility with Expo 57
   and the new architecture). Mitigation: a spike at the start of Phase 2;
   the 2D FitPreview is the fallback, so the reveal ships either way.
7. **Scope.** This is a lot. The phases are ordered so stopping after any
   one of them still leaves the product better than today.

---

## 15. Decisions Liam owns

1. Accept the "where the line is" rules in section 4.7 (gate is real, no
   overclaiming copy, ops see provenance).
2. Photos stay on the phone by default (section 5.4). Recommended: yes.
3. ObjectCapture (T1) off the default path in favour of sweep plus depth.
   Recommended: yes, revisit after the LiDAR trial.
4. Collect the player profile (age band and height only),
   subject to legal review for minors.
5. The default for the second leg: scan it, or "use this one for both".
   Recommended: scan by default, allow both.
6. Whether a lower-confidence fit should widen Fit_Clearance in CAD (needs
   Zane).
7. Product tolerances for the gate, from the Phase 0 sensitivity study with
   Zane (working placeholders: 15 mm on Leg_Length, 6 mm on fit-critical OW
   and OD).
8. Re-date ROADMAP.md now: Phase 0 absorbs the red Month 1 gate, so the App
   Store and launch weeks move (section 13 note).
9. Schema 1.1.0 approved and done (2026-11-10): leg measurements kept, CAD
   profile conversion added (section 6a.3). Tell Zane the model's inputs are
   now computed this way.
10. Wrap widths per product tier (how far round each guard reaches), with
    Zane: the first real product-line parameter.

## 16. Human-only tasks

- Five, then ten, family legs: consent, tape and two books, marked at 20, 40,
  60 and 80%, logged in docs/accuracy-log.md.
- Borrow a LiDAR iPhone for the Phase 5 trial.
- Legal review: player profile fields for minors, training-data consent text.
- Zane: the inner-dimension walkthrough and the gate tolerances.
- On-device runs of each capture build (no simulator can test capture).
