# Supabase database layer

Schema, RLS policies, and storage config for FORMS. Source of truth for
architecture and rationale is `docs/DESIGN.md`, sections 6, 8, and 9. This
README covers only how to apply and operate this directory.

## Layout

```
supabase/
  migrations/
    0001_schema.sql   tables, updated_at trigger, pipeline_jobs queue helpers
    0002_rls.sql      Row Level Security for every table
    0003_storage.sql  storage buckets + storage.objects RLS
  seed.sql            dev/local seed data (one sample product)
```

Split into three numbered files instead of one giant migration so schema,
security, and storage concerns can be reviewed and diffed independently;
Supabase applies them in filename order.

## Applying migrations

Local development (Supabase CLI, recommended):

```
supabase start          # first time only, boots local Postgres/Auth/Storage
supabase db reset        # drops, re-applies all migrations, then runs seed.sql
```

Incremental apply against a running project (local or linked remote):

```
supabase migration up
```

Without the CLI (plain psql against a Supabase project's connection string):

```
psql "$SUPABASE_DB_URL" -f supabase/migrations/0001_schema.sql
psql "$SUPABASE_DB_URL" -f supabase/migrations/0002_rls.sql
psql "$SUPABASE_DB_URL" -f supabase/migrations/0003_storage.sql
psql "$SUPABASE_DB_URL" -f supabase/seed.sql   # optional, dev/staging only
```

Never run `seed.sql` against production - it exists for local/dev/staging
convenience only.

These migrations assume the standard Supabase project bootstrap already
exists: the `anon` / `authenticated` / `service_role` roles, and default
privileges that grant new `public` and `storage` tables to those roles
automatically. That bootstrap is done by the Supabase platform itself (or
`supabase start` locally), not by anything in this directory - if you ever
apply these migrations to a bare, non-Supabase Postgres, you'll need to
create those roles and default privileges yourself first, or every table
will be reachable by RLS policies that never fire because the role has no
grant to reach the table at all. Verified locally against a throwaway
Postgres 18 cluster with a minimal stub of `auth`/`storage` and those
grants: all three migrations apply cleanly, the `claim_pipeline_job` /
`advance_pipeline_job` / `fail_pipeline_job` / `complete_pipeline_job`
helpers behave as designed, and RLS correctly isolates rows per user and
blocks cross-user storage prefixes.

## RLS philosophy

- **Default deny.** RLS is enabled on every table, including `products` and
  `audit_log`. No policy means no access, for every role, including the
  table owner queried through PostgREST.
- **Users own their rows.** Where a table has a natural owner
  (`profiles.user_id`, `scans.user_id`, `orders.user_id`), the user gets
  exactly the CRUD operations that make sense for that table and nothing
  more - see the comments in `0002_rls.sql` for the reasoning on each one
  (e.g. why users can read but never write `measurements`, why `orders` has
  no user-facing update policy).
- **Worker and admin panel use the service role, exclusively server-side.**
  The service role key bypasses RLS entirely. It lives only in the pipeline
  worker's environment and the Next.js admin panel's server-side env vars -
  **never** in `EXPO_PUBLIC_*` / `NEXT_PUBLIC_*` values, never in a mobile
  bundle, never in a client-visible response. `pipeline_jobs` and
  `audit_log` have zero user-facing policies because every legitimate reader
  or writer of those tables is a server-side process holding that key.
- **Storage mirrors the same split.** The `meshes` bucket has path-scoped
  policies so a user can only touch objects under their own `user_id/`
  prefix; the `stls` bucket has no user policies at all. In both cases,
  actual client access happens through a short-lived signed URL issued by a
  server-side route, not a direct authenticated fetch against the bucket -
  the RLS policies are the backstop, not the primary access path.

## Retention policy

Per DESIGN.md section 9.3: raw meshes exist to serve an order and to debug
the pipeline, not indefinitely. The scan's 25 measurements are the
long-lived, low-sensitivity artifact; the raw mesh is the short-lived,
high-sensitivity one.

- `scans.mesh_deleted_at` is the marker: null means the mesh (at
  `scans.mesh_path` in the `meshes` bucket) still exists; a timestamp means
  it has been purged.
- `scans.mesh_path` is intentionally left in place after deletion (it is
  historical metadata, not a live reference) - always check
  `mesh_deleted_at` before trying to read a mesh, never assume `mesh_path`
  being non-null means the object exists.
- `measurements` rows are never deleted by the retention sweep. They are
  small, versioned JSON and are what makes reordering from an old scan
  possible with zero rescan.
- There is no automated sweep implemented in this migration set yet - see
  TODOs below.

## Accounts and sign-in

The app (apps/app/src/lib/auth.ts) has two kinds of signed-in user, and no
signed-out access to any product screen:

- **Guest**: a Supabase anonymous sign-in. It is a real `auth.users` row with
  an `auth.uid()`, so every policy above already scopes its scans, orders and
  mesh uploads to it; no policy distinguishes guests. Its session lives on one
  device only: sign-out or reinstall makes its rows unreachable (they are
  orphaned, not deleted).
- **Member**: email one-time code. Same flow signs in and signs up.

A guest becomes a member by attaching an email (`updateUser({ email })` then
`verifyOtp({ type: 'email_change' })`). The user id does not change, which is
the whole reason guests are anonymous users: their library and orders carry
over with no data migration. Merging a guest into an existing member account
is not supported (the app tells them to sign in to that account instead).

Hosted project setup (Supabase dashboard, one time; `config.toml` covers
local dev):

1. Authentication > Sign In / Providers: Email enabled, "Allow anonymous
   sign-ins" on.
2. Authentication > Emails: the "Magic Link" and "Change Email Address"
   templates must include `{{ .Token }}`. The app takes a typed code, not a
   link; the hosted default templates only contain the link.
3. Authentication > Rate Limits: keep anonymous sign-ins per IP low, and
   turn on CAPTCHA before launch, since anonymous sign-in is an open endpoint.
4. Custom SMTP before real users: the built-in sender is heavily rate limited.

## Scan deletion

Users delete a scan (both legs) from the app via `request_scan_deletion`
(`0011_scan_deletion.sql`): it checks ownership, refuses scans on an order,
stamps `scans.deleted_at` (hidden from the Library at once) and dead-letters
queued jobs. Nothing is erased client-side. The service-role purge worker
erases storage objects and then the rows:

    cd services/pipeline && .venv/bin/python -m forms_pipeline.jobs.scan_deletion        # dry run
    cd services/pipeline && .venv/bin/python -m forms_pipeline.jobs.scan_deletion --arm  # erase

Schedule it alongside the retention sweep. Checks: `tests/scan_deletion_checks.sql`.

## TODOs

- **Guest cleanup.** Signed-out guests leave orphaned anonymous users and
  their scans. Add a service-role sweep deleting anonymous users with no
  orders older than N days (and their `meshes` objects), alongside the
  retention sweep.

- **Retention sweep job.** Add a `pg_cron` (or external scheduled worker)
  job that finds delivered orders past the retention window, deletes the
  corresponding storage objects in `meshes`, and sets
  `scans.mesh_deleted_at`. Needs to run as service role since users have no
  delete policy on the `meshes` bucket by design.
- **Stripe webhook idempotency table.** When payments land, add a table
  (e.g. `stripe_webhook_events`) recording processed Stripe event ids so a
  redelivered webhook can't double-apply an order status transition. Not
  needed yet since Stripe integration hasn't shipped (see DESIGN.md roadmap
  Phase 2).
- **Account deletion cascade check.** `profiles`, `scans`, `orders` all
  cascade or restrict off `auth.users` sensibly today, but this hasn't been
  exercised end-to-end against Apple's mandatory account-deletion
  requirement. Revisit once auth ships (Phase 1).
