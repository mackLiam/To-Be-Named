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

### 2026-07-06: leg naming mismatch, app read side vs DB

- `apps/app/src/lib/api.ts` and `app/(tabs)/scans.tsx` model leg as
  `'left' | 'right'`; the DB CHECK stores `'L' | 'R'`. The upload path
  (`src/lib/upload.ts`) writes the DB-correct `'L' | 'R'`.
- Harmless while the app runs on fake data; breaks the Scans list the moment
  real backend rows appear.
- Close by: reconciling the read side to `'L' | 'R'` (promote the `Leg` type
  from `upload.ts` into `@zells/shared` while at it), before the hosted
  Supabase wiring (roadmap week 5).

### 2026-07-06: no leg picker in capture flow

- `apps/app/app/capture.tsx` passes `leg: 'L'` for every scan; there is no UI
  to choose left/right.
- Close by: leg selection step in the capture flow (natural home: the
  pre-scan checklist screen, roadmap week 13, but needed before any real
  two-leg order).

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
- Close by: extend zells-capture records once the EAS dev build runs on a
  physical iPhone.

### 2026-07-06: migrations verified against local Postgres only

- 0001 through 0007 (including RLS, queue helpers, enqueue_measure_job RPC,
  storage policies) have never run against hosted Supabase; RLS and storage
  behavior differences are the known week 5 risk.
- Close by: hosted project creation + full migration apply + RLS/queue/RPC
  verification (roadmap week 5).

### 2026-07-06: enqueue RPC logic is review-only

- `supabase/migrations/0007_enqueue_rpc.sql` ownership check and
  duplicate-active-job guard (partial unique index + on conflict) cannot be
  integration-tested without a real Postgres with auth.uid(); logic is
  commented in the migration instead.
- Close by: integration test against local Supabase (supabase start) or the
  hosted project once it exists.

### 2026-07-06: Onshape provider untested against real API

- The whole CAD provider layer runs in dry_run; per-job branching/versioning
  for concurrent orders (DESIGN.md section 7 concurrency pattern) is not yet
  implemented in the Onshape provider, acceptable at concurrency 1.
- Close by: first real round-trip once Onshape keys + document access exist,
  then the per-job version/branch pattern before concurrency goes above 1.

## Closed

(none yet)
