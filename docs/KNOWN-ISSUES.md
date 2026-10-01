# Known Issues and Flags

Running ledger of known debt, mismatches, and deferred work that is not big
enough for the roadmap but must not be forgotten. One line of context, where
it lives, and what closes it. Add new entries at the top of the Open section
with a date; move to Closed (with the closing commit or reason) instead of
deleting.

Rule of use: every work session that discovers a shortcut, mismatch, or
deferral records it here in the same commit series that created it. An agent
finishing a task checks this file for anything its change closes.

## Open

### 2026-09-30: maintenance sweeps are not scheduled anywhere

- Retention (`forms_pipeline.jobs.retention`), the owner-deletion purge
  (`jobs.scan_deletion --arm`) and account deletion
  (`jobs.account_deletion --arm`) are standalone entry points with no
  scheduler, because nothing is deployed yet. Until they run, raw scans
  outlive the 30 days the privacy policy states.
- Close by: a daily scheduled run on the worker host (Fly scheduled machine
  or cron) with RETENTION_DRY_RUN=false and both --arm flags, after one
  dry run against production data (roadmap week 8 residue).

### 2026-09-30: mesh parsing has caps but no wall-clock timeout

- `extraction/mesh_loading.py` bounds file size, vertices and faces and
  parses from bytes with no resolver, but a pathological file inside those
  caps could still hold the single worker thread for a long time.
- Close by: running load + extract in a child process with a timeout once
  the worker is deployed and real parse times are known.

### 2026-09-30: storage objects with no scans row are never swept

- If an upload succeeds and the scans row insert then fails, the object
  under `meshes/<user>/` has no row, so retention, purge and account
  deletion never find it. The app retries the row insert, so this needs a
  crash between the two steps.
- Close by: a periodic listing of the meshes bucket diffed against scans
  (paged, service role), deleting objects older than a day with no row.

### 2026-09-30: payments go-live checklist (human)

- Stripe: create the account, set STRIPE_SECRET_KEY and
  STRIPE_WEBHOOK_SECRET on the web host, register the webhook endpoint
  `${SITE_URL}/api/stripe/webhook` for checkout.session.completed,
  checkout.session.expired and charge.refunded, and turn on customer
  receipt emails in the dashboard.
- Email: RESEND_API_KEY and EMAIL_FROM (a verified sender domain); the
  `support@zells.com` mailbox (SUPPORT_EMAIL) must exist and be read.
- Legal: /privacy and /terms are drafts with marked placeholders (entity,
  liability, governing law, record retention); lawyer review is roadmap
  week 14.
- Business decisions Checkout does not make yet: sales tax (Stripe Tax /
  `automatic_tax` is off), shipping cost (none is charged; the price is
  per guard), and terms acceptance (Checkout `consent_collection` needs
  the terms URL set in the Stripe dashboard first).
- The checkout success page links back with `zells://orders`, which only
  helps native payers; a desktop Expo-web payer should get a link to the
  web app instead once app.zells.com exists.

### 2026-09-30: checkout open-order cap is count-then-insert

- `apps/web/src/lib/checkout.ts` refuses a sixth pending order per user per
  24 hours, but concurrent requests can pass the cap by a few.
- Close by: an advisory-locked RPC if anyone abuses it.

### 2026-09-30: offline capture shares the OBJ instead of uploading

- With no EXPO_PUBLIC_SUPABASE_* env, `apps/app/app/capture.tsx` shows a
  "Share scan file" button after capture (AirDrop the OBJ to a Mac for
  forms-extract) instead of redirecting to the scan library.
- Close by: removing the branch once hosted Supabase exists (roadmap week 5).

### 2026-07-06: mesh upload is raw and fully in memory

- `apps/app/src/lib/upload.ts` reads the whole OBJ via `fetch(uri).blob()`
  (no expo-file-system dependency) and uploads uncompressed. Bounded by the
  100 MB cap; acceptable for Phase 0.
- Close by: zip/Draco compression plus a streaming or chunked path (roadmap
  week 6 residue; DESIGN.md section 10a lists compression as a storage cost
  control).

### 2026-07-06: capture metadata is partial

- `deviceModel` is null (needs expo-device or native surface);
  platform/osVersion come from injected env; native module does not yet
  report imageCount/detail from real hardware.
- Close by: extend forms-capture records once the EAS dev build runs on a
  physical iPhone.

### 2026-07-06: migrations verified against local Postgres only

- Every migration runs against a stubbed Postgres in CI (run_sql_checks.sh),
  but none has run against hosted Supabase; RLS and storage
  behavior differences are the known week 5 risk.
- Close by: hosted project creation + full migration apply + RLS/queue/RPC
  verification (roadmap week 5).

### 2026-07-06: Onshape provider untested against real API

- The whole CAD provider layer runs in dry_run; per-job branching/versioning
  for concurrent orders (DESIGN.md section 7 concurrency pattern) is not yet
  implemented in the Onshape provider, acceptable at concurrency 1.
- Close by: first real round-trip once Onshape keys + document access exist,
  then the per-job version/branch pattern before concurrency goes above 1.

## Closed

### 2026-09-02: products/orders column names, app read side vs DB

- `listProducts` in `apps/app/src/lib/api.ts` selects `description,
  price_cents`; `public.products` has neither (`base_price_cents`, no
  description column). `listOrders` selects `product_name, total_cents`;
  `public.orders` has `amount_cents` and only a `product_id` FK.
- Harmless while the app runs on demo rows; both list screens error the
  moment real backend rows appear.
- Close by: reconciling the read side with `supabase/migrations/0001_schema.sql`
  (join products for the name, decide whether products needs a description
  column) alongside the leg-naming fix below, before the hosted Supabase
  wiring (roadmap week 5).
- Closed 2026-09-30: fixed in 00dd5da (the app selects base_price_cents
  and joins products(name, currency)).

### 2026-07-06: leg naming mismatch, app read side vs DB

- `apps/app/src/lib/api.ts` and `app/(tabs)/scans.tsx` model leg as
  `'left' | 'right'`; the DB CHECK stores `'L' | 'R'`. The upload path
  (`src/lib/upload.ts`) writes the DB-correct `'L' | 'R'`.
- Harmless while the app runs on fake data; breaks the Scans list the moment
  real backend rows appear.
- Close by: reconciling the read side to `'L' | 'R'` (promote the `Leg` type
  from `upload.ts` into `@forms/shared` while at it), before the hosted
  Supabase wiring (roadmap week 5).
- Closed 2026-09-30: the read side uses the shared L/R Leg type
  (src/lib/library.ts).

### 2026-07-06: no leg picker in capture flow

- `apps/app/app/capture.tsx` passes `leg: 'L'` for every scan; there is no UI
  to choose left/right.
- Close by: leg selection step in the capture flow (natural home: the
  pre-scan checklist screen, roadmap week 13, but needed before any real
  two-leg order).
- Closed 2026-09-30: capture runs both legs as one pair, left then right,
  with a solo mode (8b8b40a, 802585e).

### 2026-07-06: enqueue RPC logic is review-only

- `supabase/migrations/0007_enqueue_rpc.sql` ownership check and
  duplicate-active-job guard (partial unique index + on conflict) cannot be
  integration-tested without a real Postgres with auth.uid(); logic is
  commented in the migration instead.
- Close by: integration test against local Supabase (supabase start) or the
  hosted project once it exists.
- Closed 2026-09-30: exercised by supabase/tests/*checks.sql against a
  throwaway Postgres, now run in CI (a80adf6).
