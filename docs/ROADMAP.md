# Zells - 6-Month Execution Roadmap

**Status:** v2 · **Window:** July 2026 - December 2026 · **Author:** Liam Mackenzie (with Claude)
**v2 (2026-07-06):** starting point updated to the current repo, every week expanded
into explicit tasks with acceptance criteria, and the multi-model product line
(DESIGN.md §7a: Pro / Club / Junior Max plus S/M/L presets) woven into the plan.

This document turns the phase roadmap in `DESIGN.md` §11 into a dated, week-by-week
execution plan: from the codebase as it exists on 2026-07-06 to a launched, deployed,
revenue-capable product. `DESIGN.md` stays the source of truth for architecture;
this file is the source of truth for sequencing and "what should I be working on
this week."

Rules of use:

- When a month ends, update the Reality Check log (§14) with what actually
  happened and re-date the remaining months if needed. A plan that is never
  corrected is worse than no plan.
- Do not start a month's work early if the previous month's exit gate is red.
  Gates are ordered so failures are cheap early and expensive late.
- Every task below implicitly includes its tests, its security-checklist pass,
  and a Conventional Commit (CLAUDE.md engineering standards). "Done when"
  criteria assume CI is green; none of them count without it.

---

## 0. Starting Point (what exists on 2026-07-06)

Built, tested, committed:

- **Monorepo:** pnpm workspaces + Turborepo, Makefile entry points, real CI
  (JS: build/typecheck/test/prettier; Python: ruff/pytest), Dependabot, PR template.
- **`packages/shared`:** frozen 25-variable JSON Schema (1.0.0 as of 2026-07-02,
  names confirmed against the Onshape variable table), TS types, state enums,
  Ajv validation. In flight (uncommitted): `cad.ts`, the per-product CAD model
  descriptor contract (provider registry, Onshape ref, variable_map) that
  implements DESIGN.md §7a.2.
- **Supabase migrations:** full data model (profiles, scans, measurements, products,
  orders, pipeline_jobs, audit_log), RLS deny-by-default on every table,
  Postgres-backed job queue (claim/advance/complete/fail, SKIP LOCKED, backoff,
  dead letter, execute revoked from public), private meshes/stls buckets.
  Verified against local Postgres only.
- **`services/pipeline`:** Python 3.12 worker with hardened mesh loading, PCA +
  4-slice extraction producing the 25 measurements in mm, schema-driven
  plausibility gates, Onshape client (mm-to-m at one boundary, retries, DRY_RUN),
  queue runner, extraction CLI, golden-file test harness, raw-mesh retention
  sweep with audit logging, Dockerfile. Never run against a real scan or real
  Onshape.
- **`apps/app`:** Expo Router universal app skeleton, five tabs, brand design
  system, `zells-capture` native module scaffold with a typed TS surface,
  guided capture flow wired into the Scan tab behind `isCaptureSupported()`,
  lazy Supabase client with fake-data fallback. Never built as a dev client,
  never run against a real backend.
- **`apps/web`:** Next.js scaffold with a landing page and the admin logic
  layer. Not deployed, not wired to a hosted backend.
- **Docs:** DESIGN.md (source of truth), RUNBOOK.md skeleton, accuracy-log.md
  stub, this roadmap.

Not built: the Swift side of the capture module (the scaffold's native
implementation), any deployment, auth, payments, a functioning admin panel
against real data, onboarding UX, legal/privacy artifacts, App Store presence,
any product beyond the single Club model.

**The single biggest unknown is unchanged:** no real leg has ever gone through
the pipeline. Everything in Month 1 exists to kill that unknown as fast as
possible.

---

## 1. Critical Path

Six things gate everything behind them. Keep them off the back burner at all costs:

1. **Confirm the 25 variable names with the CAD collaborator**: DONE
   2026-07-02 (Onshape variable table screenshot; schema bumped to 1.0.0).
   Residual: confirm the geometric meaning of each dimension in the model's
   sketches and that the model regenerates across the schema's plausible
   ranges (its current values are small placeholders).
2. **EAS dev build with the Swift capture module on a physical LiDAR iPhone**
   (blocks every real scan).
3. **One real scan measured with plausible values** (blocks trusting the extraction).
4. **One Onshape round-trip producing an STL** (blocks the whole product thesis).
5. **One printed guard on a real leg** (Phase 0 exit; blocks spending money on
   anything else with confidence).
6. **Accuracy validation on ~10 real legs vs tape measure** (blocks selling).

Items 1 and 2 have no dependency on each other: run them in parallel from day one.
The product line (§2) sits deliberately OFF the critical path: every additional
model and preset waits behind gate 5, because a second model of an unproven
pipeline is twice the sand.

Hardware and account purchases on the critical path:

| Item | When | Cost | Why |
|---|---|---|---|
| Apple Developer Program | Week 1 | $99/yr | EAS builds on device, TestFlight, App Store |
| Physical LiDAR iPhone (12 Pro+) | Week 1 | already owned or borrow/buy used | capture testing cannot be simulated |
| Used M1 Mac mini | Week 2-3 | ~$300 one-time | native module iterate-debug loop; later the reconstruction worker |
| Onshape private-document seat | Month 1 | confirm collaborator's seat, else ~$1,500/yr | free plan makes documents public; customer models must be private |
| Fly.io/Railway worker | Month 2 | ~$5/mo | deployed pipeline |
| Supabase Pro | Month 3 (before real customers) | $25/mo | backups, retention |

---

## 2. Product Line Plan (DESIGN.md §7a)

One frozen measurement contract, multiple parametric CAD models behind it.
Architecture supports N models from day one (the `products.cad_model`
descriptor); the schedule adds them one at a time, each behind the per-model
launch checklist in DESIGN.md §7a.4 (regeneration sweep, 3+ leg fit
validation, print validation, compliance position, catalog entry).

| Product | What it is | Enters the plan | Purchasable target |
|---|---|---|---|
| **Zells Club** (collaborator's existing model) | Balanced default guard | Now; it IS Phase 0 | Soft launch, Month 5 |
| **Zells Pro** | Minimal-coverage, low-profile guard for players who want the smallest guard allowed | Design brief with collaborator Month 3; model work Month 4-5 | Month 6 public launch if checklist passes, else Q1 2027 |
| **Zells Junior Max** | Extended-coverage youth guard; the "parents feel safe" product | Design brief Month 4 (informed by compliance findings); model work Month 5-6 | Q1 2027 |
| **S/M/L presets** (per model) | Canonical 25-value sets stored as data; cacheable STLs; no-scan SKU | Preset infrastructure Month 6; first preset SKUs (Club) Month 6 / Q1 2027 | Q1 2027 |

Standing rules for all product-line work:

- A new model NEVER changes the 25-variable schema. If a model seems to need a
  26th input, that is a schema 2.0 conversation with a migration plan, not an
  ad hoc addition. Raise it explicitly.
- Each model is a separate Onshape document/element addressed by its product's
  `cad_model` descriptor; the worker stays model-agnostic.
- The Pro tier's coverage floor is bounded by the §12.4 compliance
  investigation (DESIGN.md §12.8). Do not brief the collaborator on Pro until
  the Month 4 compliance findings say how small "small" may be.
- Junior Max sizing for the youngest kids will lean on presets (scanning a
  toddler reliably is unlikely); that pairs its model work with the preset
  infrastructure.
- Every purchasable (model, size-mode) combination appears in the golden-file
  and regeneration-sweep suites before it appears in the shop.

---

## 3. Month 1 (July 2026) - Phase 0: Prove the Pipeline

Goal: hold a printed guard generated from a phone scan with zero manual CAD.
Nothing else this month matters if this does not happen.

### Week 1 (Jul 1-7): unblock the two parallel tracks

Track A - CAD contract:

- [x] Variable names confirmed, schema frozen 1.0.0 (2026-07-02).
- [ ] Send the collaborator a dimension diagram (ISW/ISD/ICW/ICD/OW/OD per
  slice, slice positions at 20/40/60/80% measured up from the ankle bottom,
  S1 nearest the ankle) and book the sketch-walkthrough call: for each of the
  six dimensions, which sketch entity does it drive, and what does the model
  do between slices (loft? spline?).
- [ ] Get read access to the Onshape document. Create Onshape API keys, store
  in `.env` (never committed), add placeholders to `.env.example`.
- [ ] Land the CAD descriptor contract both sides: finish `packages/shared`
  `cad.ts` (validator + tests), mirror in `services/pipeline` (Pydantic or
  equivalent validator + tests), add the `products.cad_model jsonb` migration.
  Contract-first rule applies: the JSON shape is frozen before either side
  merges.
- [ ] Decision to force this week: does the model live in the collaborator's
  paid seat or does Zells need its own Standard seat? (DESIGN.md §7 vendor
  risk: push for a company-owned copy either way.)

Track B - capture build:

- [ ] Enroll in the Apple Developer Program (processing can take days; do it
  first, before anything else on this track).
- [x] TS surface of `zells-capture` scaffolded; guided capture flow wired
  into the Scan tab behind `isCaptureSupported()`.
- [ ] Implement the Swift side as an Expo config plugin: `ObjectCaptureSession`
  for guided capture, `PhotogrammetrySession` for on-device reconstruction,
  exporting USDZ/OBJ into the app sandbox, progress events across the bridge.
  Set `ios.deploymentTarget` 17.0, add camera/photo permission strings.
- [ ] First EAS dev-client build (`eas build --profile development --platform
  ios`). Expect pain (signing, entitlements, provisioning). Budget the whole
  week for a build that installs and opens.

Done when: build installs on the LiDAR iPhone and opens to the tab bar; CAD
descriptor contract merged with validators on both sides; walkthrough call
booked; API keys work against the Onshape document (a GET of the variable
table from a scratch script).

### Week 2 (Jul 8-14): first real capture

- [ ] `ObjectCaptureSession` end to end on device: capture your own leg,
  reconstruct on device, export OBJ to the sandbox, surface the file path to
  the TS layer.
- [ ] Capture ergonomics notes: seated vs standing, phone-holder vs selfie,
  pant leg rolled, lighting. Write observations into `docs/accuracy-log.md`;
  they become Month 4 onboarding copy.
- [ ] Pull the OBJ off the device (Files app / share sheet is fine) and run it
  through the extraction CLI locally. Expect wrong or implausible values;
  log everything (axis choice, slice heights, all 25 values).
- [ ] Buy the used M1 Mac mini when the EAS cloud-build loop starts hurting
  (it will): local Xcode builds turn the native-module iterate loop from ~20
  minutes to ~2.
- [ ] Sketch-walkthrough call happens this week if it did not in week 1.
  Output: one paragraph per dimension in DESIGN.md §1 territory (update the
  doc), plus the model's valid input ranges compared against the schema's
  plausibility ranges.

Done when: an OBJ captured on the phone produces 25 values from the CLI, and
each dimension's geometric meaning is written down and agreed.

### Week 3 (Jul 15-21): extraction correctness on real meshes

- [ ] Capture 3-5 real legs (family, friends; consent noted). Vary body types.
- [ ] Hand-measure each leg with a tape measure at the four slice heights.
  Record ground truth + pipeline output + deltas in `docs/accuracy-log.md`.
  Month 1 target: within ~5% on widths/depths, ~2% on length.
- [ ] Attack the known hard problems as they appear: PCA axis on a partial leg
  scan, foot/knee cropping, mesh holes, scale sanity (LiDAR should be metric;
  verify against the tape measure before trusting anything else).
- [ ] Golden-file suite for real: 2-3 real OBJs (small, anonymized, with
  consent) into `tests/fixtures/` with hand-verified expected values, wired
  into pytest and CI. The Sketchfab mesh stays as plumbing-test scan #0.
- [ ] Regeneration sweep script (first product-line artifact): drive the
  Onshape model across the schema's plausible ranges (min/mid/max per
  variable, plus the real captured value sets) in DRY_RUN first, real API
  once keys and the round-trip exist. This is DESIGN.md §7a.4 item 1 and it
  is reusable for every future model.

Done when: golden files in CI; accuracy log has 3+ legs with deltas; sweep
script exists and passes in DRY_RUN.

### Week 4 (Jul 22-31): the round-trip and the print

- [ ] Onshape client against the real API: per-job branch/version (never write
  to a shared workspace), set the 25 variables through the descriptor's
  variable_map, poll regeneration, export STL, clean up the branch. Measure
  and log per-job latency from the very first call (DESIGN.md §7 ceiling).
- [ ] Run the regeneration sweep against the real model. File every failure
  with the collaborator (placeholder values are far below plausible ranges;
  expect sketch constraints to break somewhere).
- [ ] Full local pipeline run: phone scan → extraction → gates → Onshape →
  STL on disk. Repeat for at least two different legs.
- [ ] Print it. Any local print service or hobby printer; material fidelity
  does not matter yet, geometric fit does. Put it on the scanned leg.
- [ ] Write the fit report: what is wrong (something will be), and is the fix
  extraction-side, model-side, or capture-side. This document decides where
  Month 2's spare cycles go.

**Month 1 exit gate:** printed guard from a real scan with zero manual CAD;
schema 1.0.0 frozen; sweep run against the real model. If this slips, let it
eat Month 2; do not start Phase 1 infrastructure early.

---

## 4. Month 2 (August 2026) - Phase 1: Walking Skeleton in Production

Goal: one user can go scan to STL on deployed infrastructure, and you can watch
it happen from an admin page.

### Week 5 (Aug 1-7): real backend

- [ ] Create the hosted Supabase project. Apply all migrations. Re-verify RLS
  and queue helpers against hosted Postgres (local-only so far): run the
  policy test suite as an authenticated user, an anon user, and the service
  role; confirm deny-by-default held.
- [ ] Supabase Auth: Sign in with Apple + email OTP. App auth flow: login
  screen, session persistence (secure storage), sign out in Profile,
  auth-state routing (logged-out users see login, not tabs).
- [ ] Replace the app's fake-data fallback with the real client for scans,
  products, and orders; keep the fallback behind a dev-only flag.
- [ ] Seed the products table with the Club product carrying a real
  `cad_model` descriptor pointing at the collaborator's document. First use
  of the descriptor path in anger.
- [ ] `.env.example` updated for every new variable; confirm no secret is
  reachable from the client bundle (only `EXPO_PUBLIC_*`).

Done when: login on the physical phone against hosted Supabase, scan list
reads real (empty) tables, RLS test evidence recorded.

### Week 6 (Aug 8-14): upload path and job wiring

- [ ] Capture flow uploads: compress the OBJ (zip minimum; Draco only if
  cheap), request a short-lived signed upload URL, upload to the private
  meshes bucket, create the scan row, enqueue the measure job. Size cap
  enforced client-side AND storage-policy-side.
- [ ] Upload resilience: progress UI, retry on transient failure, explicit
  failure state with a retry button. Scans are minutes of user effort; do not
  lose one to a dropped connection.
- [ ] Deploy the worker to Fly.io or Railway (Docker image exists). Secrets
  via the platform secret store. Worker consumes the hosted queue.
- [ ] End-to-end smoke test: phone scan → upload → worker measures → gates
  pass → measurements row lands → scan status flips in the app in near-real
  time (poll or Supabase realtime, whichever is less code).

Done when: the smoke test passes from the phone with no laptop involved in the
data path (the worker is deployed).

### Week 7 (Aug 15-21): admin panel (first real `apps/web` feature work)

- [ ] Deploy the Next.js scaffold to Vercel: `zells.com` placeholder landing
  page (real marketing comes Month 5).
- [ ] `/admin` on the existing admin logic layer: order/job queue table
  (paginated, never unbounded), per-job state and error, failed-scan triage
  view (which gate failed, the 25 values vs plausible ranges), break-glass
  STL download via server-generated signed URL.
- [ ] Admin auth: Supabase role check server-side; the service key lives only
  in server components/route handlers. Verify the admin bundle ships no
  secrets (inspect the build output).
- [ ] Audit log writes on every admin action (table exists; wire it).

Done when: you can watch a job progress from the admin page, and a
deliberately failed scan (feed it a garbage mesh) shows a useful triage view.

### Week 8 (Aug 22-31): full pipeline in production + retention

- [ ] Onshape step running from the deployed worker: scan → STL in the stls
  bucket with no laptop involved. Per-job latency lands in pipeline_jobs
  artifacts for the Month 6 ceiling decision.
- [ ] Turn on the retention sweep in production (it is built): raw meshes
  auto-deleted N=30 days after job completion, measurements JSON kept
  forever, deletions audit-logged. Shipping it now makes Month 4's privacy
  policy true instead of aspirational.
- [ ] Sentry on app + worker (free tier), PII scrubbing on, release tagging
  wired to commits. Error visibility before beta users, not after.
- [ ] Buffer: hosted-infra surprises are baked into this month (RLS behavior
  drift, storage CORS, EAS env handling). The buffer is not optional; if it
  goes unused, pull week 9's accuracy campaign forward.

**Month 2 exit gate:** you, on your phone, with no terminal open, produce an
STL in production storage, and see the whole journey in the admin panel.

---

## 5. Month 3 (September 2026) - Phase 2: Sellable

Goal: a stranger could pay you money and receive a guard. Also: prove accuracy
on enough real legs to justify letting strangers do that.

### Week 9 (Sep 1-7): accuracy campaign (the product risk, front-loaded)

- [ ] Scan ~10 real legs (teammates, family, a youth team if reachable),
  spanning adult male/female and youth builds; the spread matters more than
  the count. For each: guided capture, tape-measure ground truth, pipeline
  run, deltas in `docs/accuracy-log.md`. Best meshes join the golden suite.
- [ ] Decide from data, not vibes: is capture quality the bottleneck (fix UX
  guidance Month 4), extraction (fix algorithm NOW), or both?
- [ ] If accuracy threatens fit: prototype the fiducial-marker sleeve
  (DESIGN.md §12.1) this week, not later.
- [ ] Youth-leg data note: youth scans double as the anthropometric seed for
  Junior Max sizing and the eventual preset value sets (§2). Record age
  bracket (with consent) alongside measurements.

### Week 10 (Sep 8-14): orders and Stripe

- [ ] Orders flow in the app: pick a product (the picker reads the products
  table and must render N products, not hardcode one; the product line
  arrives later but the UI contract starts now), pick left/right scan(s),
  shipping address capture with validation, Stripe Payment Sheet.
- [ ] Stripe webhook (Supabase Edge Function or a worker route): verify
  signature, idempotent processing keyed by event id, flip order status,
  audit log. Never trust the client's word that payment happened.
- [ ] Order states through the existing state machine: paid orders enqueue
  the CAD job automatically, with the product's `cad_model` descriptor
  resolved per job.
- [ ] Refund/cancel path in admin (mark refunded, stop the pipeline job if
  not yet printed). You will need it in week 20; build it calm.

Done when: a test-mode payment produces a paid order that automatically lands
an STL in the bucket, and a replayed webhook does nothing twice.

### Week 11 (Sep 15-21): fulfillment (manual admin path) and ops

- [ ] Admin fulfillment queue: "queued for print" view, download STL, mark
  printing, enter tracking number, mark shipped. Customer sees status and
  tracking in Orders.
- [ ] Pick the print partner. Order test prints in the real material and
  settle material/process with them (DESIGN.md §12.5: wall thickness
  assumptions live in the parametric model; loop in the collaborator). Get
  their price per guard: it sets the pricing floor for week 19.
- [ ] PostHog funnel: scan started, scan succeeded, scan failed (by gate),
  order started, order paid. Scan failure rate is the #1 product metric
  from here on.
- [ ] Email notifications (Supabase or Resend free tier): order confirmed,
  shipped with tracking. Plain text is fine; silence is not.

### Week 12 (Sep 22-30): hardening pass + Pro design brief

- [ ] Load the pipeline: 20 queued jobs at once; verify Onshape concurrency
  1-2, backoff, dead-letter behavior, and that one poison mesh cannot wedge
  the worker.
- [ ] Formal security pass against the CLAUDE.md checklist: every table's RLS
  re-verified on hosted infra, bucket policies, webhook signatures, signed
  URL TTLs, size/time caps on all input paths, grep the built app bundle for
  secrets.
- [ ] Upgrade Supabase to Pro before real customer data (backups, PITR).
- [ ] Dress rehearsal: pay real money on your own card, receive the printed
  guard in the mail. Note every rough edge; that list is Month 4's backlog.
- [ ] Product line: write the **Zells Pro design brief** with the collaborator
  (kick off only; model work is Month 4-5). Contents: target silhouette,
  weight target, how the model derives its smaller coverage from the same 25
  inputs, and the open coverage-floor question flagged as pending the
  compliance investigation (DESIGN.md §12.8). Explicit agreement: same
  variable names, same schema, separate document.

**Month 3 exit gate:** a paid order flowed scan-to-shipped with no manual step
except the admin print handoff; accuracy on 10 legs documented and acceptable
for fit; Pro brief exists.

---

## 6. Month 4 (October 2026) - Phase 3a: Beta Quality

Goal: strangers can succeed at scanning without you standing next to them, and
the legal/privacy story is real. This month is UX and trust, not features.

### Week 13 (Oct 1-7): onboarding and scan guidance

- [ ] The single biggest quality lever (DESIGN.md §12.1). Build: pre-scan
  checklist (lighting, shorts/rolled pant leg, someone else holds the phone
  if possible), in-capture coaching around Apple's UI, post-scan instant
  feedback: which gates failed, what to do differently, one-tap rescan.
- [ ] Every plausibility-gate failure reason maps to one human instruction
  (a `gate → copy` table in the app, tested). No raw error strings to users.
- [ ] Feed September's PostHog scan-failure data into the guidance copy.
- [ ] UI pass with zells-designer standards: this flow is the product's first
  impression; no AI-slop layouts.
- [ ] Find the lawyer this week (needed in week 14, and lawyers have lead
  times).

### Week 14 (Oct 8-14): privacy, minors, deletion, compliance

- [ ] Privacy policy and terms, lawyer-reviewed. The minors/parental-consent
  question (DESIGN.md §9.4, §12.6) gets a real answer: likely a 13+ gate
  plus parental-consent flow for younger users, but take the lawyer's word
  over this document's. Junior Max and the toddler-preset plan (§2) make
  this non-optional: the youth product IS the sensitive-data product.
- [ ] In-app: delete-my-scans, full account deletion (App Store requirement),
  data-retention disclosure matching the already-running retention sweep.
- [ ] Start the protective-equipment compliance investigation (NOCSAE ND090 /
  EN 13061, DESIGN.md §12.4): what certification requires, cost, lead time,
  and per-design vs per-batch implications for custom geometry. Two product
  decisions hang on the answer: marketing claims (Month 5) and the Pro
  tier's coverage floor (DESIGN.md §12.8). Deliverable: a one-page findings
  memo by week 16.

### Week 15 (Oct 15-21): TestFlight beta

- [ ] TestFlight build to 10-20 real users (target: youth players and
  parents, the actual market). Give them nothing but the app and a feedback
  form.
- [ ] Watch PostHog and Sentry daily; triage scan failures in the admin
  panel. Expect the success rate to drop hard vs supervised scans; that
  delta is the remaining UX work, quantified.
- [ ] Ship guidance fixes in fast iterations all week (EAS Update for JS-only
  changes; native changes ride new builds).

### Week 16 (Oct 22-31): web build of the product app

- [ ] Expo web output deployed at `app.zells.com`: login, scan library, shop,
  orders, profile. Scan tab shows the "scan on your iPhone" state on web.
  Stripe Checkout for web payments.
- [ ] Mesh upload path (OBJ/USDZ from Polycam/Scaniverse etc.) per DESIGN.md
  §5: LiDAR-derived sources only, plausibility gates, user-confirmed
  knee-to-ankle reference measurement as cross-check and rescale. Clearly
  labeled the secondary path in the UI.
- [ ] Beta round 2 with week 15 fixes.
- [ ] Compliance findings memo lands; unblock or re-scope the Pro brief
  accordingly, and set Junior Max's coverage targets from the same findings.
  Collaborator starts Pro model work.

**Month 4 exit gate:** beta users' unsupervised scan success rate above an
explicit bar (suggest: 70%+ first-attempt, 90%+ within two attempts), legal
artifacts exist, account deletion works, compliance memo written.

---

## 7. Month 5 (November 2026) - Phase 3b: Launch Preparation

Goal: everything App Store review and a paying stranger needs, done calmly
instead of at the last minute.

### Week 17 (Nov 1-7): marketing site and story

- [ ] `zells.com` for real: what it is, how it works (scan → custom guard),
  price, FAQ (device requirements stated plainly: iPhone 12 Pro or later
  Pro, iOS 17+), compliance/certification status stated honestly per the
  Month 4 memo, privacy story as a selling point.
- [ ] Product-line page structure even while only Club is purchasable:
  the Pro and Junior Max tiers listed as "coming soon" with a notify-me
  email capture. This validates demand for both tiers before their model
  work finishes, with zero pipeline cost.
- [ ] SEO basics, OpenGraph, App Store link placeholder. Brand rules apply
  (white/orange/navy, Outfit/Manrope).

### Week 18 (Nov 8-14): App Store submission

- [ ] Listing assets: screenshots, preview video of the capture flow,
  description, keywords. Age rating and privacy nutrition labels must match
  actual data practices (they are real now, so this is transcription, not
  fiction).
- [ ] Submit early in the week. Expect first-pass rejection (capture
  permissions copy, account-deletion discoverability, payments wording are
  the usual suspects). Budget the whole week for round-trips.
- [ ] Reorder flow ships: order again from stored measurements, any platform,
  no rescan; also the cross-model reorder (same measurements, different
  guard model) since measurements are model-agnostic. This is the retention
  policy's payoff and the product line's cheapest upsell.

### Week 19 (Nov 15-21): operational readiness

- [ ] Fill in `docs/RUNBOOK.md` (skeleton exists): dead-lettered job,
  Onshape rate-limit, repeatedly failing mesh, Stripe dispute, Supabase
  incident, "customer says the guard doesn't fit" (the support path that
  actually matters: refund vs re-print vs rescan decision tree).
- [ ] Alerts: Sentry rules, dead-letter-queue notification (email or Slack
  webhook from a scheduled function), daily order/scan digest.
- [ ] Fulfillment SLA agreed with the print partner (turnaround days, defect
  policy). Launch pricing decided (floor = print cost + shipping + Stripe;
  sanity-check against stock premium guards). Initial capacity: how many
  orders/week the manual path absorbs (probably 10-20).
- [ ] Cost check: at 50 orders/month, DESIGN.md §10a says ~$75/mo fixed;
  verify actuals.
- [ ] Pro model first regeneration sweep + first test print if the
  collaborator's model is ready (per-model checklist §7a.4 items 1 and 3).

### Week 20 (Nov 22-30): soft launch

- [ ] App approved and released, marketed only to the beta cohort and one
  local team/club. Goal: 10-20 real paid orders from people you can talk to
  when something goes wrong.
- [ ] Watch the funnel end to end; fix the sharpest edge every day.
- [ ] Go/no-go for public launch on: scan success rate, fit feedback from
  delivered guards, fulfillment turnaround, support load.

**Month 5 exit gate:** app live in the App Store, web app live, 10+ paid
orders delivered to non-family customers, runbook exists.

---

## 8. Month 6 (December 2026) - Launch, Stabilize, Grow the Line

Goal: public launch, first real customer cohort, first product-line expansion,
and honest data on what Q1 2027 should be.

### Weeks 21-22 (Dec 1-14): public launch

- [ ] Marketing site CTA on; announce where the audience is (youth soccer
  communities, local clubs, Instagram/TikTok of the printing process, which
  is inherently good content).
- [ ] Support loop: respond to every failed scan personally; each one is free
  UX research. Guidance fixes weekly.
- [ ] Track the three numbers that decide everything next: scan success rate,
  order conversion from successful scan, per-order pipeline latency (the
  Onshape ceiling, DESIGN.md §7).
- [ ] **Zells Pro launch attempt:** run the full per-model checklist
  (DESIGN.md §7a.4): sweep, 3+ leg fit validation from the beta cohort's
  stored measurements plus fresh prints, print validation, compliance
  position, catalog entry with its own `cad_model` descriptor. If any item
  fails, Pro slips to Q1 2027 without drama; the checklist exists precisely
  so this is a checklist decision, not a judgment call.

### Weeks 23-24 (Dec 15-31): stabilize, presets, point at Q1

- [ ] Fix the top three funnel drop-offs, whatever they are.
- [ ] **Preset infrastructure** (DESIGN.md §7a.3): preset value sets stored
  per (product, size) as data validated against the schema; pipeline path
  that generates and caches one STL per (model, size, model-version);
  admin ability to define/edit presets. Seed Club S/M/L from the
  accuracy-log's accumulated real-scan distributions plus anthropometric
  tables. Selling presets can wait for Q1; the plumbing lands now while
  it is quiet.
- [ ] **Junior Max design brief** finalized with the collaborator: coverage
  targets from the compliance memo, youth slice-dimension data from the
  accuracy log, preset-first sizing for the youngest ages. Model work is a
  Q1 2027 deliverable.
- [ ] Holiday lull: write the **December decision memo** from real data:
  - Onshape ceiling: at current per-order latency and volume growth, when
    does the queue back up? If under ~6 months away, schedule the
    CadQuery/build123d port (DESIGN.md §7) for Q1. Note: every new product
    model multiplies port effort; if the port is coming, cap the Onshape
    model count and sequence the port before Junior Max, not after.
  - Android/server-side reconstruction: what share of interested users
    bounced on the device floor (instrument the marketing site and in-app)?
    If large, the Mac mini reconstruction worker is the next big build.
    Presets partially hedge this in the meantime (no-scan SKU).
  - Print partner API vs manual fulfillment: at what weekly volume does the
    manual path break?
  - Product line: did Pro convert? What does the notify-me list say about
    Junior Max demand?
- [ ] Housekeeping: dependency updates, test-suite gaps found during launch,
  accuracy-log review, DESIGN.md updated to reflect reality.

**Month 6 exit gate:** publicly launched; Pro either live or explicitly
re-scoped by checklist; preset plumbing merged; a written data-backed Q1 2027
plan; DESIGN.md and this file updated to match what actually happened.

---

## 9. Workstream Summary (what runs through the whole 6 months)

| Workstream | M1 | M2 | M3 | M4 | M5 | M6 |
|---|---|---|---|---|---|---|
| Capture (native module, UX) | build Swift side | wire upload | - | guidance UX | polish | iterate |
| Extraction and accuracy | real meshes | - | 10-leg campaign | gate copy | - | review |
| CAD/Onshape | walkthrough + round-trip + sweep | deployed | latency watch | - | Pro sweep | port decision |
| Product line (§2) | descriptor contract | Club product seeded | Pro brief | compliance memo, Pro model starts | Pro print test | Pro launch, presets, Junior Max brief |
| Backend (Supabase, queue) | - | hosted + RLS | webhooks | deletion | alerts | stabilize |
| App (Expo) | scan tab | auth + real data | orders + Stripe | onboarding | reorder | fixes |
| Web (Next.js + Expo web) | - | admin panel | - | app.zells.com | zells.com | - |
| Ops and observability | - | Sentry | PostHog + load test | beta triage | runbook | funnel |
| Legal and compliance | Onshape seat | - | print material | privacy + minors + NOCSAE/EN memo | App Store | Pro coverage position |
| Money spent (new, monthly) | $99/yr + iPhone/Mac | +$5 worker | +$25 Supabase | - | +$19 EAS (opt) | - |

## 10. Standing Weekly Rhythm

- Tests ship with every feature (CLAUDE.md standards; CI enforces).
- Every Friday: update `docs/accuracy-log.md` if any scans happened, glance
  at Sentry and the dead-letter queue, and check this roadmap: am I on the
  critical path or polishing something that does not gate anything?
- Every change touching scans/measurements/orders gets the security checklist
  pass (RLS, secrets, signed URLs, input validation, server-side authz).
- Every change touching the 25-variable shape or the CAD descriptor is a
  both-sides-in-lockstep change (shared TS + Python validators + docs), per
  the contract-first rule.
- Do not start a month's work early if the previous month's exit gate is red.

## 11. Definition of Done (applies to every task above)

A task is done when ALL of:

1. The owning package's CI commands pass locally (see `.github/workflows/ci.yml`
   and `Makefile`); failures reported verbatim, never claimed green without
   running.
2. Tests are in the same change: unit tests for logic, schema-validation tests
   for anything touching the 25-variable or CAD-descriptor contracts, and
   edge/failure cases (bad mesh, out-of-range value, API error), not just the
   happy path.
3. The security checklist passed for the touched surface.
4. If a design decision changed, DESIGN.md changed in the same commit series.
5. Committed with a Conventional Commit and pushed to `develop`.

## 12. Testing Matrix (what "tested" means per layer)

| Layer | Suite | Must cover |
|---|---|---|
| `packages/shared` | Vitest | schema validation both directions, CAD descriptor validation, state-enum exhaustiveness |
| `services/pipeline` extraction | pytest + golden files | real-mesh fixtures with hand-verified values, degenerate meshes (holes, cropped, non-manifold, huge, empty), scale sanity |
| `services/pipeline` gates | pytest | every plausibility bound at, below, above threshold; gate-to-reason mapping |
| `services/pipeline` Onshape client | pytest with fakes | mm-to-m at the single boundary, variable_map application, retry/backoff, DRY_RUN parity, per-job branch lifecycle |
| Queue | pytest against Postgres | claim/advance/complete/fail, SKIP LOCKED under concurrency, backoff schedule, dead letter, poison-job isolation |
| RLS | SQL tests, hosted | per-table: owner sees own, stranger sees nothing, anon sees nothing, service role bypass only server-side |
| `apps/app` | Vitest + manual device pass | capture gating per platform, upload retry, gate-failure copy mapping, auth routing |
| `apps/web` admin | Vitest + manual | server-side role check, no service key in client bundle, pagination bounds |
| Webhooks | integration | signature verify, idempotent replay, out-of-order events |
| End to end | scripted smoke test | phone scan → paid order → STL in bucket → admin fulfillment states |

## 13. Top Schedule Risks (and the planned response)

1. **Swift capture module takes longer than two weeks** (most likely slip).
   Response: let it eat Month 1's weeks 3-4; extraction iteration proceeds on
   Polycam/Scaniverse meshes meanwhile, since the pipeline starts at "OBJ in
   storage."
2. **Collaborator latency**, now on model work rather than names (names froze
   2026-07-02). Sketch-walkthrough latency blocks the round-trip; Pro/Junior
   Max model latency blocks only the product line, never the core. Response:
   book calls a week ahead, keep briefs written and small, and keep every
   product-line date soft while core dates stay hard.
3. **Accuracy not good enough on real legs** (the existential risk). Response:
   scheduled early (weeks 3, 9) so there is time for the fiducial sleeve or
   capture-UX pivots before launch commitments.
4. **App Store rejection loops.** Response: submission week 18 with two full
   weeks of slack; deletion and privacy labels done in Month 4, not invented
   during review.
5. **Compliance matters more than hoped for sanctioned play** (DESIGN.md
   §12.4). Response: investigation starts week 14 with a written memo in week
   16. Worst case: launch positioning is "training and recreational play",
   Pro's minimal cut is re-scoped to the certifiable floor, and Junior Max
   (where certification is a selling point) gets prioritized over Pro.
6. **Product line distracts from the critical path.** The temptation is real:
   models are fun, infrastructure is not. Response: hard rule in §2: no
   model work before gate 5; every product-line date is soft; the weekly
   rhythm question ("am I on the critical path?") exists for exactly this.
7. **Solo-founder bandwidth.** This plan assumes roughly full-time effort. If
   reality is part-time, stretch each phase proportionally but keep the order
   and the gates; do not parallelize across gates to "catch up."

---

## 14. Reality Check Log

Update at each month boundary.

- **2026-07-01:** Plan written (v1). Repo state: scaffold complete, zero real
  scans, zero deployments.
- **2026-07-02:** Critical-path item 1 closed: the 25 variable names and the
  slice convention (20/40/60/80% of Leg_Length measured from the bottom of
  the ankle; Leg_Length is ankle bottom to knee) confirmed against the
  Onshape variable table. Schema bumped to 1.0.0 across TS, Python, and docs.
  Extraction slice orientation fixed to match (S1 nearest the ankle;
  EXTRACTION_VERSION 0.2.0). Dev environment verified end to end (pnpm via
  corepack shim, all JS and Python suites green). New idea logged: S/M/L
  standard-size presets derived from the parametric model.
- **2026-07-06:** Roadmap v2. Progress since v1: zells-capture TS scaffold and
  guided capture flow in the Scan tab, raw-mesh retention sweep with audit
  logging, queue-helper execute revoked from public, Next.js scaffold with
  landing page and admin logic layer, CAD descriptor contract started in
  `packages/shared` (uncommitted). Product decision adopted into DESIGN.md
  §7a: multi-model product line (Pro / Club / Junior Max) plus S/M/L presets,
  sequenced in §2 of this file; all product-line work gated behind Phase 0.
