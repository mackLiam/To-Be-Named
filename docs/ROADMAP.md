# Zells - 6-Month Execution Roadmap

**Status:** v1 · **Window:** July 2026 - December 2026 · **Author:** Liam Mackenzie (with Claude)

This document turns the phase roadmap in `DESIGN.md` §11 into a dated, week-by-week
execution plan: from the codebase as it exists on 2026-07-01 to a launched, deployed,
revenue-capable product. `DESIGN.md` stays the source of truth for architecture;
this file is the source of truth for sequencing and "what should I be working on
this week."

Rule of use: when a month ends, update the Reality Check section at the bottom
with what actually happened, and re-date the remaining months if needed. A plan
that is never corrected is worse than no plan.

---

## 0. Starting Point (what exists on 2026-07-01)

Built and tested:

- **Monorepo:** pnpm workspaces + Turborepo, Makefile entry points, real CI
  (JS: build/typecheck/test/prettier; Python: ruff/pytest), Dependabot, PR template.
- **`packages/shared`:** frozen 25-variable JSON Schema (0.1.0-draft, names NOT yet
  confirmed with the CAD collaborator), TS types, state enums, Ajv validation, 8 tests.
- **Supabase migrations:** full data model (profiles, scans, measurements, products,
  orders, pipeline_jobs, audit_log), RLS deny-by-default on every table,
  Postgres-backed job queue (claim/advance/complete/fail, SKIP LOCKED, backoff,
  dead letter), private meshes/stls buckets. Verified against local Postgres only.
- **`services/pipeline`:** Python 3.12 worker with hardened mesh loading, PCA +
  4-slice extraction producing the 25 measurements in mm, schema-driven
  plausibility gates, Onshape client (mm-to-m at one boundary, retries, DRY_RUN),
  queue runner, Dockerfile, 40 tests. Never run against a real scan or real Onshape.
- **`apps/app`:** Expo Router universal app skeleton, five tabs, brand design
  system, platform-gated capture (native module stubbed), lazy Supabase client
  with fake-data fallback, 18 tests. Never built as a dev client, never run
  against a real backend.

Not built: native capture module, any deployment, auth, payments, admin panel,
`apps/web`, onboarding UX, legal/privacy artifacts, App Store presence.

**The single biggest unknown:** no real leg has ever gone through the pipeline.
Everything in Month 1 exists to kill that unknown as fast as possible.

---

## 1. Critical Path

Six things gate everything behind them. Keep them off the back burner at all costs:

1. **Confirm the 25 variable names with the CAD collaborator** (blocks the real
   Onshape integration; schema is 0.1.0-draft until then).
2. **EAS dev build with the Swift capture module on a physical LiDAR iPhone**
   (blocks every real scan).
3. **One real scan measured with plausible values** (blocks trusting the extraction).
4. **One Onshape round-trip producing an STL** (blocks the whole product thesis).
5. **One printed guard on a real leg** (Phase 0 exit; blocks spending money on
   anything else with confidence).
6. **Accuracy validation on ~10 real legs vs tape measure** (blocks selling).

Items 1 and 2 have no dependency on each other: run them in parallel from day one.

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

## 2. Month 1 (July 2026) - Phase 0: Prove the Pipeline

Goal: hold a printed guard generated from a phone scan with zero manual CAD.
Nothing else this month matters if this does not happen.

### Week 1 (Jul 1-7): unblock the two parallel tracks

Track A - CAD contract:

- Send the collaborator the current `measurements.schema.json` with a diagram of
  each dimension (ISW/ISD/ICW/ICD/OW/OD per slice, slice positions at 20/40/60/80%).
  Ask for: exact Onshape variable names, units the model expects, and the valid
  input range per variable from the model's perspective.
- Get read access to the Onshape document. Create Onshape API keys.
- Decision to force this week: does the model live in the collaborator's paid
  seat or does Zells need its own Standard seat? (DESIGN.md §7 vendor risk:
  push for a company-owned copy either way.)

Track B - capture build:

- Enroll in the Apple Developer Program (processing can take days; do it first).
- Scaffold the Swift native module as an Expo config plugin:
  `ObjectCaptureSession` for guided capture, `PhotogrammetrySession` for
  on-device reconstruction, exporting USDZ/OBJ to the app sandbox.
- First EAS dev-client build. Expect this to be painful (signing, entitlements,
  iOS 17 minimum). Budget the whole week for a build that installs and opens.

### Week 2 (Jul 8-14): first real capture

- Get `ObjectCaptureSession` running end to end on the device: capture a leg
  (your own), reconstruct, export OBJ.
- Wire the module to the existing Scan tab behind the existing
  `isCaptureSupported()` gate. Rough UX is fine; this is a lab tool for now.
- Run the exported OBJ through `zells_pipeline` extraction locally. Expect the
  first results to be wrong or implausible; log everything.
- Buy the Mac mini when the EAS cloud-build loop starts hurting (it will).

### Week 3 (Jul 15-21): extraction correctness on real meshes

- Iterate the extraction against 3-5 captures of real legs (family, friends).
  Known hard problems: PCA axis on a partial leg scan, foot/knee cropping,
  mesh holes, scale sanity (LiDAR should be metric, verify it).
- Hand-measure each scanned leg with a tape measure. Compare all 25 values.
  Target this month: within ~5% on widths/depths, ~2% on length. Record results
  in `docs/accuracy-log.md` (create it; this becomes the golden-file provenance).
- Start the golden-file suite for real: check 2-3 real OBJs (small, anonymized,
  with consent) into `tests/fixtures/` with hand-verified expected values, wired
  into pytest and CI.
- Incorporate the collaborator's variable-name answers: bump the schema to
  1.0.0, update the TS types, extraction, and Onshape client together (the
  anti-drift tests should force this).

### Week 4 (Jul 22-31): the round-trip and the print

- Onshape client against the real API: per-job branch/version (never write to a
  shared workspace), set the 25 variables, poll regeneration, export STL.
  Measure and log per-job latency from the first call (DESIGN.md §7).
- Full pipeline run: phone scan, extraction, gates, Onshape, STL on disk.
- Print it. Use any local print service or a hobby printer; material fidelity
  does not matter yet, geometric fit does. Put it on the scanned leg.
- Write up what is wrong with the fit (there will be something) and whether the
  fix is extraction-side, model-side, or capture-side.

**Month 1 exit gate:** printed guard from a real scan with zero manual CAD, and
schema 1.0.0 frozen with the collaborator. If this slips, let it eat Month 2;
do not start Phase 1 infrastructure early, it would be building on sand.

---

## 3. Month 2 (August 2026) - Phase 1: Walking Skeleton in Production

Goal: one user can go scan to STL on deployed infrastructure, and you can watch
it happen from an admin page.

### Week 5 (Aug 1-7): real backend

- Create the hosted Supabase project. Apply the migrations. Verify RLS and the
  queue helpers against hosted Postgres (they were only ever tested locally).
- Supabase Auth: Sign in with Apple + email OTP. Wire the app's auth flow
  (login screen, session persistence, sign out in Profile).
- Replace the app's fake-data fallback path with the real client for scans,
  products, and orders. Keep the fallback for local dev only.

### Week 6 (Aug 8-14): upload path and job wiring

- Capture flow uploads: compress the OBJ (zip at minimum, Draco if cheap to
  add), request a short-lived signed upload URL, upload to the private meshes
  bucket, create the scan row, enqueue the measure job.
- Deploy the worker to Fly.io or Railway (Docker image already exists). Secrets
  via the platform secret store. Worker consumes the hosted queue.
- End-to-end smoke test: phone scan, upload, worker measures, gates pass,
  measurements row lands, scan status flips in the app.

### Week 7 (Aug 15-21): admin panel (first real `apps/web` work)

- Next.js on Vercel. Two surfaces this week, nothing more:
  - `zells.com` placeholder landing page (real marketing comes Month 5).
  - `/admin`: order/job queue table, per-job state and error, failed-scan
    triage view (which gate failed, the 25 values), break-glass STL download
    via server-generated signed URL. Admin auth: Supabase role check
    server-side; the service key lives only in server components/route handlers.
- Audit log writes on every admin action (table already exists).

### Week 8 (Aug 22-31): full pipeline in production + retention

- Onshape step running from the deployed worker (not just locally): scan to
  STL in the stls bucket with no laptop involved.
- Implement the retention job: raw meshes auto-deleted N days after the job
  completes (pick N=30 for now), measurements JSON kept forever. This is both
  the privacy policy and the storage cost control; shipping it early makes the
  privacy policy in Month 4 true instead of aspirational.
- Sentry on app + worker (free tier), PII scrubbing on. You want error
  visibility before beta users, not after.
- Buffer: this month has hosted-infra surprises baked in (RLS behavior
  differences, storage CORS, EAS env handling). The buffer is not optional.

**Month 2 exit gate:** you, on your phone, with no terminal open, produce an
STL in production storage, and see the whole journey in the admin panel.

---

## 4. Month 3 (September 2026) - Phase 2: Sellable

Goal: a stranger could pay you money and receive a guard. Also: prove accuracy
on enough real legs to justify letting strangers do that.

### Week 9 (Sep 1-7): accuracy campaign (the product risk, front-loaded)

- Scan ~10 real legs (teammates, family, a youth team if reachable). For each:
  guided capture, tape-measure ground truth, run the pipeline, log deltas in
  `docs/accuracy-log.md`. Add the best meshes to the golden-file suite.
- Decide from data, not vibes: is capture quality the bottleneck (fix UX
  guidance in Month 4), or extraction (fix algorithm now), or both?
- If accuracy is bad enough to threaten fit: this is the moment to prototype
  the fiducial-marker sleeve idea (DESIGN.md §12.1), not later.

### Week 10 (Sep 8-14): orders and Stripe

- Orders flow in the app: pick a product, pick left/right scan(s), shipping
  address capture, Stripe Payment Sheet. Web checkout can wait for the Expo
  web build (Month 4); mobile first.
- Stripe webhook (Supabase Edge Function or a route on the worker): verify
  signature, idempotent processing keyed by event id, flip order status, write
  audit log. Never trust the client's word that payment happened.
- Order states wired through the existing state machine: paid orders enqueue
  the CAD job automatically.

### Week 11 (Sep 15-21): fulfillment (manual admin path) and ops

- Admin panel: "queued for print" view, download STL, mark printing, enter
  tracking number, mark shipped. Customer sees status and tracking in Orders.
- Pick the print partner. Order test prints in the real material and settle
  the material/process choice with them (DESIGN.md §12.5: wall thickness
  assumptions in the parametric model depend on this; loop in the collaborator).
- PostHog: instrument the funnel that matters: scan started, scan succeeded,
  scan failed (by gate), order started, order paid. Scan failure rate is the
  number one product metric from here on.

### Week 12 (Sep 22-30): hardening pass

- Load the pipeline: 20 queued jobs at once; verify concurrency 1-2 against
  Onshape, backoff, dead-letter behavior, and that one poison mesh cannot
  wedge the worker.
- Security review against the CLAUDE.md checklist as a formal pass: every
  table's RLS re-verified on hosted infra, bucket policies, webhook signatures,
  signed URL TTLs, no secrets in any client bundle (grep the built app bundle).
- Upgrade Supabase to Pro before real customer data (backups).
- End-to-end dress rehearsal: pay real money on your own card, receive the
  printed guard in the mail.

**Month 3 exit gate:** a paid order flowed scan-to-shipped with no manual step
except the admin print handoff, and accuracy on 10 legs is documented and
acceptable for fit.

---

## 5. Month 4 (October 2026) - Phase 3a: Beta Quality

Goal: strangers can succeed at scanning without you standing next to them, and
the legal/privacy story is real. This month is UX and trust, not features.

### Week 13 (Oct 1-7): onboarding and scan guidance

- The single biggest quality lever (DESIGN.md §12.1). Build: pre-scan checklist
  (lighting, shorts/rolled pant leg, someone else holds the phone if possible),
  in-capture coaching around Apple's UI, post-scan instant feedback (gates
  failed: show which and what to do differently, one-tap rescan).
- Feed October's PostHog scan-failure data into the guidance copy. Every gate
  failure reason should map to a human instruction.

### Week 14 (Oct 8-14): privacy, minors, deletion

- Privacy policy and terms (lawyer-reviewed; find the lawyer in week 13, not
  week 14). The minors/parental-consent question (DESIGN.md §9.4, §12.6) gets
  a real answer this week: likely a 13+ gate plus parental consent flow, but
  take the lawyer's word over this document's.
- In-app: delete-my-scans, full account deletion (App Store requirement),
  data-retention disclosure that matches the already-running retention job.
- Start the protective-equipment compliance investigation (NOCSAE/EN 13061,
  DESIGN.md §12.4). This is a business-model question with long lead times;
  you need the answer before marketing makes claims, i.e. before Month 5.

### Week 15 (Oct 15-21): TestFlight beta

- TestFlight build to 10-20 real users (target: youth players and parents,
  the actual market). Give them nothing but the app and a feedback form.
- Watch PostHog and Sentry daily. Triage scan failures in the admin panel.
  Expect the scan success rate to drop hard vs. your supervised scans; that
  delta is the remaining UX work, quantified.
- Ship guidance fixes in fast iterations all week.

### Week 16 (Oct 22-31): web build of the product app

- Expo web output deployed at `app.zells.com`: login, scan library, shop,
  orders, profile. Scan tab shows the "scan on your iPhone" state. Stripe
  Checkout for web payments.
- Mesh upload path (OBJ/USDZ from Polycam/Scaniverse etc.) per DESIGN.md §5:
  LiDAR-derived sources only, plausibility gates, plus the user-confirmed
  reference measurement (knee-to-ankle cm) cross-check and rescale. This is
  the compatibility path, clearly labeled secondary in the UI.
- Beta round 2 with fixes from week 15.

**Month 4 exit gate:** beta users' unsupervised scan success rate is above an
explicit bar you set (suggest: 70%+ first-attempt, 90%+ within two attempts),
legal artifacts exist, account deletion works.

---

## 6. Month 5 (November 2026) - Phase 3b: Launch Preparation

Goal: everything App Store review and a paying stranger needs, done calmly
instead of at the last minute.

### Week 17 (Nov 1-7): marketing site and story

- `zells.com` for real: what it is, how it works (scan → custom guard), price,
  FAQ (device requirements: iPhone 12 Pro or later Pro, iOS 17+, stated
  plainly), compliance/certification status stated honestly per the Month 4
  investigation, privacy story as a selling point.
- SEO basics, OpenGraph, and the App Store link placeholder. Brand rules apply
  (white/orange/navy, Outfit/Manrope, no AI-slop layouts).

### Week 18 (Nov 8-14): App Store submission

- Listing assets: screenshots, preview video of the capture flow, description,
  keywords. Age rating and privacy nutrition labels must match the actual data
  practices (they are real now, so this is transcription, not fiction).
- Submit for review early in the week. Expect rejection on the first pass
  (capture permissions copy, account deletion discoverability, and payments
  wording are the usual suspects). Budget the whole week for the round-trips.
- Reorder flow ships: order again from stored measurements, any platform, no
  rescan (measurements JSON is kept forever; this is the retention policy's
  payoff).

### Week 19 (Nov 15-21): operational readiness

- Runbook in `docs/RUNBOOK.md`: what to do when a job dead-letters, when
  Onshape rate-limits, when a mesh fails repeatedly, when Stripe disputes.
- Alerts: Sentry alert rules, a dead-letter-queue notification (email or
  Slack webhook from a scheduled function), daily order/scan digest.
- Fulfillment SLA agreed with the print partner (turnaround days, defect
  policy). Decide launch pricing and initial inventory-free capacity
  (how many orders/week the manual fulfillment path can absorb: probably 10-20).
- Load and cost check: at 50 orders/month, per DESIGN.md §10a you should be
  around $75/mo fixed. Verify actuals against that table.

### Week 20 (Nov 22-30): soft launch

- App approved and released, but marketed only to the beta cohort and one
  local team/club. The goal is 10-20 real paid orders from people you can
  talk to when something goes wrong.
- Watch the funnel end to end. Fix the sharpest edge every day.
- Go/no-go decision for public launch based on: scan success rate, fit
  feedback from delivered guards, fulfillment turnaround, and support load.

**Month 5 exit gate:** app live in the App Store, web app live, 10+ paid
orders delivered to non-family customers, runbook exists.

---

## 7. Month 6 (December 2026) - Launch and Stabilize

Goal: public launch, first real customer cohort, and honest data on what
Phase 4 should be.

### Weeks 21-22 (Dec 1-14): public launch

- Turn on the marketing site CTA, announce wherever the audience is (youth
  soccer communities, local clubs, Instagram/TikTok of the printing process,
  which is inherently good content).
- Support loop: respond to every failed scan personally for now; each one is
  free UX research. Keep shipping guidance fixes weekly.
- Track the three numbers that decide everything next: scan success rate,
  order conversion from successful scan, and per-order pipeline latency
  (the Onshape ceiling from DESIGN.md §7).

### Weeks 23-24 (Dec 15-31): stabilize and point at Phase 4

- Fix the top three drop-off points in the funnel, whatever they are.
- Holiday reality: fulfillment slows and youth soccer is off-season in much
  of the market; use the lull for the December decision memo, written from
  real data:
  - **Onshape ceiling:** at current per-order latency and volume growth, when
    does the queue back up? If under ~6 months away, schedule the CadQuery/
    build123d port (DESIGN.md §7 exit strategy) for Q1 2027.
  - **Android/server-side reconstruction:** what share of interested users
    bounced on the device floor? (Instrument this on the marketing site and
    in-app.) If large, the Mac mini reconstruction worker is the next big
    build.
  - **Print partner API** vs. manual fulfillment: at what weekly volume does
    the manual path break?
- Housekeeping while it is quiet: dependency updates, test-suite gaps found
  during launch, accuracy-log review, DESIGN.md updated to reflect reality.

**Month 6 exit gate:** publicly launched, a written data-backed plan for Q1
2027, and DESIGN.md/this file updated to match what actually happened.

---

## 8. Workstream Summary (what runs through the whole 6 months)

| Workstream | M1 | M2 | M3 | M4 | M5 | M6 |
|---|---|---|---|---|---|---|
| Capture (native module, UX) | build | wire upload | - | guidance UX | polish | iterate |
| Extraction and accuracy | real meshes | - | 10-leg campaign | gate copy | - | review |
| CAD/Onshape | names + round-trip | deployed | latency watch | - | - | port decision |
| Backend (Supabase, queue) | - | hosted + RLS | webhooks | deletion | alerts | stabilize |
| App (Expo) | scan tab | auth + real data | orders + Stripe | onboarding | reorder | fixes |
| Web (Next.js + Expo web) | - | admin panel | - | app.zells.com | zells.com | - |
| Ops and observability | - | Sentry | PostHog + load test | beta triage | runbook | funnel |
| Legal and compliance | Onshape seat | - | print material | privacy + minors | App Store | - |
| Money spent (new, monthly) | $99/yr + iPhone/Mac | +$5 worker | +$25 Supabase | - | +$19 EAS (opt) | - |

## 9. Standing Weekly Rhythm

- Tests ship with every feature (CLAUDE.md standards; CI enforces).
- Every Friday: update `docs/accuracy-log.md` if any scans happened, glance at
  Sentry and the dead-letter queue, and check this roadmap: am I on the
  critical path or polishing something that does not gate anything?
- Every change touching scans/measurements/orders gets the security checklist
  pass (RLS, secrets, signed URLs, input validation, server-side authz).
- Do not start a month's work early if the previous month's exit gate is red.
  The gates are ordered so that failures are cheap early and expensive late.

## 10. Top Schedule Risks (and the planned response)

1. **Capture module takes longer than two weeks** (most likely slip). Response:
   let it eat Month 1's weeks 3-4; extraction iteration can proceed on meshes
   from any scanning app (Polycam) in the meantime, since the pipeline starts
   at "OBJ in storage."
2. **Collaborator latency on variable names.** Response: escalate week 1; the
   schema freeze blocks the Onshape client. If truly stuck, build against
   self-chosen names in a company-owned copy of the model and reconcile later.
3. **Accuracy is not good enough on real legs** (the existential risk).
   Response: it is scheduled early (weeks 3, 9) precisely so there is time for
   the fiducial sleeve or capture-UX pivots before launch commitments.
4. **App Store rejection loops.** Response: submission is week 18 with two
   full weeks of slack before soft launch; account deletion and privacy labels
   are done in Month 4, not invented during review.
5. **Compliance turns out to matter for sanctioned play** (DESIGN.md §12.4).
   Response: investigation starts week 14. Worst case, launch positioning is
   "training and recreational play" until certification is sorted; that is a
   marketing constraint, not a product blocker.
6. **Solo-founder bandwidth.** This plan assumes roughly full-time effort. If
   reality is part-time, stretch each phase proportionally but keep the order
   and the gates; do not parallelize across gates to "catch up."

---

## 11. Reality Check Log

Update at each month boundary.

- **2026-07-01:** Plan written. Repo state: scaffold complete (see §0), zero
  real scans, zero deployments.
