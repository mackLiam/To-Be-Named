# Zells - System Design Document

**Status:** Draft v1 · **Date:** 2026-07-01 · **Author:** Liam Mackenzie (with Claude)

---

## 1. Product Summary

Zells sells custom-fit, 3D-printed soccer shin guards. A user scans their leg with
their phone; the app extracts 25 measurements from the reconstructed mesh; those
measurements drive a parametric CAD model that generates a print-ready STL; the
guard is printed and shipped. The core value proposition is a **fully automated
scan-to-print pipeline** - no human touches a CAD file per customer.

The scan is never printed directly. It is a *measurement instrument*. The printed
geometry always comes from the parametric model, which guarantees printability,
consistent wall thickness, and consistent protective properties regardless of
scan noise.

### The 25 variables

- `Leg_Length` (1)
- Four cross-sections S1-S4 at 20/40/60/80% of leg length, each with six
  dimensions: `ISW`, `ISD`, `ICW`, `ICD`, `OW`, `OD` (24)

---

## 2. Goals and Non-Goals

### Goals

1. Prove the scan → measurements → CAD → STL pipeline end-to-end with real scans.
2. Ship an iOS app first; keep the architecture Android- and web-ready.
3. Fully automated per-order geometry generation - zero manual CAD work.
4. A stack a solo/small team can operate, that won't need a rewrite at 10k orders/month.
5. Treat leg scans as sensitive personal data from day one.

### Non-Goals (for now)

- Android on-device photogrammetry (no OS API exists; addressed via server-side path, §6).
- Owning print hardware / print-farm software (outsource fulfillment initially).
- Real-time scan feedback beyond what Apple's capture UI provides.
- Multi-region deployment, SSO/enterprise features, team accounts.

---

## 3. Architecture Overview

```
┌─────────────────────┐     ┌──────────────────────┐
│  iOS app (RN/Expo   │     │  Web app (Next.js)   │
│  + Swift capture    │     │  account, orders,    │
│  native module)     │     │  marketing, admin    │
└─────────┬───────────┘     └──────────┬───────────┘
          │  HTTPS (Supabase client + REST)         
          ▼                            ▼
┌──────────────────────────────────────────────────┐
│                 Supabase (managed)               │
│  Auth · Postgres (RLS) · Storage (meshes, STLs)  │
│  Edge Functions (thin API glue, webhooks)        │
└─────────────────────┬────────────────────────────┘
                      │ job queue (Postgres-backed)
                      ▼
┌──────────────────────────────────────────────────┐
│         Pipeline worker (Python / FastAPI)       │
│  1. fetch OBJ from Storage                       │
│  2. PCA axis-find + slice → 25 measurements      │
│  3. push variables → Onshape REST API            │
│  4. poll regen, export STL → Storage             │
│  5. mark order ready-to-print                    │
└─────────────────────┬────────────────────────────┘
                      ▼
        Fulfillment (print partner API / manual)
        Payments: Stripe · Errors: Sentry · Analytics: PostHog
```

Guiding principle: **the phone captures; the backend computes.** Everything after
mesh upload is server-side, so iOS, Android, and web all converge on the same
pipeline, and the pipeline can be tested without any phone at all.

---

## 4. Tech Stack (recommended, with rationale)

| Layer | Choice | Why |
|---|---|---|
| Product app (iOS + Android + web) | React Native + **Expo Router universal app** (custom dev client / EAS) | Already started; one codebase ships as both native apps *and* the web app (`app.zells.com`) - identical UX across platforms by construction (see §5). Must move off Expo Go. |
| Capture module | **Swift native module** wrapping `ObjectCaptureSession` / `PhotogrammetrySession` | Only way to reach Apple photogrammetry. Small, isolated, testable surface. iOS-only; gated off on other platforms. |
| Marketing + admin | **Next.js (TypeScript)** on Vercel | `zells.com` SEO pages + internal admin panel. Server components keep admin secrets off the client. |
| Monorepo | **pnpm workspaces + Turborepo** | Share types (measurement JSON schema, order states), API client, and design tokens between mobile and web. |
| Language (app tier) | **TypeScript everywhere** | One shared type for the 25-variable payload prevents the most likely class of pipeline bug: key/unit mismatches. |
| Backend platform | **Supabase** (Auth, Postgres, Storage, Edge Functions) | Already planned. Postgres + Row Level Security + signed storage URLs covers 90% of backend needs with near-zero ops. Portable: it's just Postgres if you ever leave. |
| Pipeline service | **Python 3.12 + FastAPI worker** (trimesh/numpy/scipy) | The measurement script is already Python; the geometry ecosystem (trimesh, open3d) is Python-native. Runs as a queue consumer, not a user-facing API. |
| Job queue | **Postgres-backed queue** (pgmq or Graphile Worker) | Pipeline jobs are minutes-long and must survive restarts/retries. Using Postgres avoids a second piece of infrastructure (no Redis/SQS yet). Swap for SQS later if needed. |
| Worker hosting | **Fly.io or Railway** (Docker) | Cheap always-on container, scale-to-N later. Modal is a good alternative if jobs become bursty/GPU-bound. |
| CAD generation | **Onshape REST API** (MVP) | Collaborator's parametric model already exists and accepts the 25 variables. See §7 for the scaling caveat and exit strategy. |
| Payments | **Stripe** (Payment Sheet on mobile, Checkout on web) | Industry default; handles SCA/tax/receipts. Never touch card data. |
| Auth | **Supabase Auth**: Sign in with Apple + email OTP (+ Google for Android/web later) | Sign in with Apple is required by App Store review when any third-party login is offered. |
| CI/CD | **GitHub Actions** + **EAS Build/Submit** (mobile), Vercel (web), Docker deploy (worker) | Solves the "no Mac" problem for release builds - EAS builds iOS in the cloud (see §5). |
| Errors / analytics | **Sentry** (app + worker) · **PostHog** (funnel: scan started → scan succeeded → order) | Scan failure rate is the #1 product metric; instrument it from day one. |

### Deliberately deferred

- Kubernetes, microservices, GraphQL, Redis, Kafka: unnecessary below ~10k orders/month.
- Custom auth, custom file CDN: Supabase covers both.
- In-house print farm software: use a fulfillment partner's API first.

---

## 5. Platform Strategy

### iOS (first)

- `ObjectCaptureSession` (guided capture UI) requires **iOS 17+ and a LiDAR
  device** (iPhone 12 Pro and later Pro models). On-device
  `PhotogrammetrySession` reconstruction has its own device floor (A14+, RAM
  gated). **Decide and enforce a minimum supported device list early** - it
  directly shapes the addressable market and the App Store listing.
- **Critical:** `PhotogrammetrySession` cannot run inside Expo Go. The path is:
  Expo custom dev client (`expo-dev-client`), a Swift native module (config
  plugin) exposing capture + reconstruction, built via **EAS Build** - which
  also removes the Windows/Mac-VM blocker for producing installable builds.
  A physical iPhone with LiDAR is still required for testing capture itself.
- **Dev-machine recommendation:** skip MacStadium (~$100+/mo). A **used M1 Mac
  mini (~$250-350 one-time)** pays for itself inside three months, gives real
  Xcode + device debugging (EAS cloud builds are slow for iterate-debug loops on
  a native module), and later becomes the server-side reconstruction worker for
  Android/older iPhones (§ below) - one purchase, three jobs.

### Android (later)

- No OS photogrammetry API. Two options:
  1. **Server-side reconstruction (recommended):** Android app captures a guided
     photo burst, uploads images, backend reconstructs. Reconstruction options:
     a Mac mini worker running macOS `PhotogrammetrySession` (cheap, same output
     format as iOS), or a paid API (Luma AI, KIRI Engine).
  2. Third-party on-device SDK - pricier and quality varies.
- Because the pipeline is server-side from the OBJ onward (§3), Android support
  is *only* a capture problem, not a pipeline problem. This is the main payoff
  of the "phone captures, backend computes" split.
- The server-side reconstruction path is also a **fallback for older iPhones**
  (photo upload instead of on-device reconstruction), widening the iOS market.

### Web

- No capture on web (no camera-based photogrammetry worth shipping). Everything
  else has **full parity** with the mobile app: same account, same scan library,
  same shop, same order history - guaranteed structurally because there is only
  one backend (Supabase) and both clients are thin views over it. A scan made on
  the phone is immediately visible and orderable on the web, and vice-versa for
  orders.
- **Codebase strategy - one product app, three platforms:** build the product
  surface (login, scans, shop, orders, profile) as a single **Expo Router
  universal app** that ships as the iOS app, the Android app, *and* the web app
  (served at `app.zells.com` via Expo's web output). Identical look and behavior
  across all three is then automatic, not a discipline to maintain across two
  codebases. Platform-only features (the capture flow) are gated: on web/Android
  the "Scan" tab becomes "scan on your iPhone, it appears here" until server-side
  reconstruction ships.
- **Browser upload path:** because the pipeline starts at "mesh file in storage,"
  the web app can also accept a **direct upload** instead of capturing:
  1. *Mesh upload (OBJ/USDZ)* - e.g. from Polycam/Scaniverse or any scanner app.
     Technically trivial to support, but carries the **scale problem**: an OBJ
     has no units, and pure-photogrammetry meshes (no LiDAR) have *arbitrary
     scale* - every measurement would be precisely, plausibly wrong. Accept only
     sources with trustworthy real-world scale (LiDAR-derived), enforce the §6
     plausibility gates, and require a user-confirmed reference measurement
     (e.g. knee-to-ankle length in cm) as a cross-check - and to rescale when
     the mesh is uniform but unscaled - before the scan is marked valid.
  2. *Photo/video upload → server-side reconstruction* - same backend path
     already planned for Android (§ above); the browser is just another capture
     client. Ships when the reconstruction worker ships; capture-guidance UX
     (coverage, lighting, distance) is the quality risk without a native
     guided-capture UI.
  Primary path stays the guided iPhone capture (best quality, known scale);
  upload is the fallback/compatibility path, not the default.
- **Next.js stays, but smaller:** `zells.com` marketing/SEO pages and the
  **internal admin panel** (order queue, pipeline job status, failed-scan
  triage, break-glass STL download). These want SEO and server-side secrets
  respectively - the two things Expo web is worst at.
- **Scan reuse & reorder:** a validated scan's 25 measurements are small JSON
  kept indefinitely (only the heavy raw mesh is deleted per the retention policy
  in §9.3). Reordering - same measurements, different guard model/style - is a
  measurements-only operation, so it works forever, from any platform, with no
  rescan, and costs nothing to store.

---

## 6. Scan → Print Pipeline Design

Model the pipeline as an **explicit state machine persisted in Postgres**, one row
per scan job. Every arrow is a queue-driven worker step with retries and a
dead-letter state:

```
captured → uploaded → measuring → measured → generating_cad
        → stl_ready → queued_for_print → printing → shipped
   (any step) → failed(step, reason, retriable)
```

Step details:

1. **Capture (device):** Apple capture UI → USDZ/OBJ export → compress → upload
   to Supabase Storage via short-lived signed URL. Client never talks to the
   worker directly.
2. **Measure (worker):** `extract_shin_measurements.py` logic - PCA axis, four
   slices, 25 values. Add **validation gates**: each measurement checked against
   human-plausible ranges (e.g., calf width 6-16 cm); out-of-range → job fails
   with a user-facing "please rescan" reason rather than generating garbage
   geometry. Log all 25 values per job for drift analysis.
3. **CAD (worker):** push variables to Onshape via REST, poll regeneration,
   export STL, store next to the scan. **Units:** Onshape stores meters
   internally regardless of display units - the worker owns a single
   canonical-units boundary (pipeline computes in mm, converts to meters exactly
   once, at the Onshape client). The 25 variable names must match the Onshape
   model exactly - freeze them in a shared, versioned JSON Schema that the
   extraction script, the TypeScript types, and the Onshape client all validate
   against (this is the #1 integration risk; confirm names with collaborator
   before building the client).
4. **Fulfillment:** initially manual (admin downloads STL, sends to print
   partner, marks shipped). Later: print partner API + webhook status updates.

Cross-cutting rules:

- **Idempotency everywhere.** Every step keyed by `job_id`; re-running a step is
  safe. Onshape calls carry the job id so a retry doesn't double-generate.
- **Never mutate, always version.** Keep raw mesh, measurements JSON, and STL
  per job. A pipeline bug can be re-run against stored meshes without asking
  users to rescan; measurement history enables regression testing when the
  extraction algorithm changes.
- **Golden-file test suite:** a library of real OBJ scans with hand-verified
  expected measurements, run in CI against the extraction script. Start building
  it with the first real scan (the Sketchfab OBJ works as scan #0 for plumbing
  tests, not accuracy tests).

---

## 7. Onshape: Fine for MVP, a Bottleneck at Scale

Onshape is the right MVP choice - the model exists and is validated. Known
constraints to design around:

- **Rate limits & latency:** API regeneration + export is seconds-to-minutes per
  part and rate-limited per account. At meaningful order volume this becomes the
  pipeline's throughput ceiling. Mitigation now: queue with concurrency of 1-2
  and measure per-order latency from day one.
- **Concurrency:** parallel orders must not fight over one workspace. Pattern:
  create a per-job branch/version (or per-job copy of the document), set
  variables, export, delete. Never write variables into a shared workspace two
  jobs use simultaneously.
- **Vendor risk:** per-seat pricing, API terms, and the model living in a
  collaborator's account. Get the document into a company-owned Onshape account
  early.
- **Exit strategy (post-PMF):** port the parametric model to code-CAD -
  **CadQuery or build123d** (Python, OCCT kernel). Geometry generation then runs
  in-process in the worker: no external API, no rate limits, pennies per part,
  horizontally scalable. Significant one-time effort; do it only after the
  product is validated. The architecture already isolates this behind a single
  "CAD client" interface in the worker, so it's a swap, not a rewrite.

---

## 8. Data Model (sketch)

```
users          id, auth_id, email, created_at
profiles       user_id, name, shipping_address, preferred_leg_sizes
scans          id, user_id, leg (L/R), status, mesh_path, capture_meta
               (device model, iOS version, capture duration), created_at
measurements   id, scan_id, schema_version, values(jsonb: 25 vars),
               extraction_version, validated(bool), created_at
products       id, name, base_price, active            -- guard models/styles
orders         id, user_id, product_id, scan_id_left, scan_id_right,
               status, stripe_payment_intent, amount, address(json), created_at
pipeline_jobs  id, order_id, step, status, attempts, error, started_at,
               finished_at, artifacts(jsonb: stl_path, onshape_refs)
```

Notes:

- Measurements stored as versioned JSONB against the frozen schema - when the
  extraction algorithm changes, `extraction_version` lets you re-run and compare.
- A guard is per-leg: orders reference up to two scans.
- **Row Level Security on every table**; users see only their own rows. Admin
  access via a service role used exclusively server-side (worker, admin panel
  API routes) - the service key never ships in any client.

---

## 9. Security & Privacy

A 3D scan of a body part is sensitive personal data (biometric-adjacent under
GDPR; special-category risk if minors use the app - likely, given youth soccer).
Design accordingly from day one; retrofitting privacy is far harder than
retrofitting features.

1. **Transport & storage:** TLS everywhere; Supabase Storage private buckets;
   all mesh/STL access via short-lived signed URLs; encryption at rest (managed).
2. **Least privilege:** clients get scoped, RLS-constrained tokens only. Worker
   uses the service role from server-side env/secrets manager. No secrets in the
   mobile bundle - anything in the app binary is public.
3. **Data minimization & retention:** raw meshes exist to serve orders and debug
   the pipeline. Policy: auto-delete raw meshes N days after order delivery
   (keep only the 25 measurements, which are far less sensitive), with explicit
   opt-in to retain the scan for easy reordering. In-app "delete my scans" and
   full account deletion (App Store requires account deletion anyway).
4. **Minors:** likely under-16 users → parental-consent flow and a COPPA/GDPR-K
   review before launch. Flag for legal review; do not silently ignore.
5. **Payments:** Stripe-hosted fields/sheets only; PCI SAQ-A scope. Store the
   Stripe customer/payment-intent ids, never card data.
6. **Pipeline hardening:** the worker parses user-supplied OBJ files - treat as
   untrusted input (size caps, vertex-count caps, parse in a sandboxed
   container, timeouts). Malformed mesh must fail a job, never the worker.
7. **Webhooks:** verify Stripe (and later print-partner) signatures; process
   idempotently.
8. **Operational:** Sentry PII scrubbing on; audit log on admin actions;
   dependency scanning (Dependabot) in CI; secrets in platform secret stores,
   never in the repo.

---

## 10. Scalability Posture

Scale problems arrive in this order, and the design meets each with the cheapest
adequate answer:

| Bottleneck | When | Answer already in the design |
|---|---|---|
| Pipeline throughput (Onshape) | ~100s of orders/week | Queue + measured latency now; code-CAD port later (§7) |
| Reconstruction compute (Android/older-iPhone path) | When server-side capture ships | Stateless workers; add Mac minis or cloud API horizontally |
| Storage cost (meshes are 10-100 MB) | ~1k scans | Retention policy (§9.3) + storage lifecycle rules |
| Postgres | Very late | Supabase scales vertically a long way; RLS design is portable |
| Web/API traffic | Late | Vercel + Supabase are elastic; nothing stateful in app tier |

Everything stateful lives in Postgres + object storage; every compute tier
(Next.js, Edge Functions, Python worker) is stateless and horizontally
scalable. That single property is what keeps this architecture from needing a
rewrite.

---

## 10a. Cost Posture (startup budget)

The stack was chosen so that pre-revenue burn is close to zero. Estimated
monthly costs:

| Item | Pre-launch | Early revenue (~100 orders/mo) |
|---|---|---|
| Supabase | $0 (free tier) | $25 (Pro - needed for backups/retention) |
| Vercel (web) | $0 (Hobby) | $0-20 |
| Worker (Fly.io/Railway) | ~$5 | ~$10-20 |
| EAS Build | $0 (free-tier builds) | $19 (production plan, optional if builds infrequent) |
| Sentry + PostHog | $0 (free tiers) | $0 |
| Stripe | $0 | % of revenue only (no fixed fee) |
| Apple Developer | $99/yr (unavoidable) | $99/yr |
| Onshape | ⚠ see below | ⚠ |
| Mac mini (used M1) | ~$300 **one-time** | - |
| **Total fixed** | **≈ $15/mo + one-times** | **≈ $75/mo** |

Cost rules:

- **Onshape is the one licensing trap:** the free plan makes all documents
  *public*. A customer-measurement-driven CAD model must be private → Standard
  plan (~$1,500/yr) on a company account, or confirm the collaborator's existing
  paid seat can host it. This is the largest fixed cost in the stack and one
  more reason the code-CAD exit (§7) matters - CadQuery/build123d is free.
- **Buy, don't rent, the Mac:** used M1 mini beats MacStadium rental within
  ~3 months and doubles as the reconstruction worker later.
- **No fixed-cost infrastructure before it's earned:** no Redis, no dedicated
  queue service, no k8s - the Postgres-backed queue and free tiers carry the
  product to real order volume. Every paid upgrade in the table is triggered by
  revenue-linked volume, so costs scale *behind* income, not ahead of it.
- **Storage is the sneaky variable cost** (meshes are 10-100 MB each): the
  retention policy in §9.3 is a cost control as much as a privacy control.
  Compress meshes (Draco/zip) before upload.

---

## 11. Roadmap

Dated, week-by-week execution plan for these phases: **`docs/ROADMAP.md`**.

**Phase 0 - prove the pipeline (current):**
real scan via EAS dev build on a LiDAR iPhone (or borrowed Mac for the interim) →
extraction on real mesh → freeze the 25-variable JSON Schema with collaborator →
Onshape API round-trip → hold a printed guard generated with zero manual CAD.
*Everything else waits on this.*

**Phase 1 - walking skeleton:** monorepo, Supabase (auth, DB, storage, RLS),
worker + queue with the state machine, capture native module in the app, admin
page showing job states. One user can go scan → STL in production infrastructure.

**Phase 2 - sellable:** Stripe, orders flow, shipping capture, fulfillment
(manual admin path), Sentry + PostHog, measurement validation gates, golden-file
CI suite.

**Phase 3 - launch:** onboarding + scan-guidance UX (biggest quality lever),
privacy policy + data deletion + minors review, App Store assets, web build of
the product app (`app.zells.com`), re-order from stored measurements.

**Phase 4 - expand:** Android (server-side reconstruction), print-partner API,
code-CAD port when volume justifies it.

---

## 12. Top Risks & Open Questions

1. **Scan accuracy on real legs** (skin texture is low-feature; photogrammetry
   hates that). Mitigations: capture UX guidance; the parked **fiducial-marker
   sleeve** idea is genuinely strong - it doubles as a product accessory and a
   capture-consistency fix. Validate accuracy vs. tape-measure ground truth on
   ~10 real legs before trusting the pipeline.
2. **Onshape variable-name mismatch** - confirm names with collaborator and
   freeze the schema before writing the integration.
3. **Device floor** - LiDAR-only capture may exclude a large share of the target
   market; server-side reconstruction path (§5) is the hedge. Decide early.
4. **Protective-equipment compliance** - soccer shin guards are safety gear
   (NOCSAE ND090 in US school/college play, CE EN 13061 in the EU). A custom
   guard that isn't certified may be unusable in sanctioned matches. This is a
   business-model-level question; investigate before launch, not after.
5. **Print material/process choice** (impact resistance vs. printability) -
   affects the parametric model's wall thickness assumptions; needs testing with
   the fulfillment partner.
6. **Minors & consent** (§9.4) - legal review required pre-launch.
