-- 0001_schema.sql
-- Zells core schema: tables, triggers, and the pipeline_jobs queue helpers.
--
-- Design references: docs/DESIGN.md sections 6 (pipeline state machine),
-- 8 (data model sketch), 9 (security and privacy).
--
-- Postgres version: targets Postgres 15 (Supabase managed). gen_random_uuid()
-- has been a built-in core function since Postgres 13, so no CREATE EXTENSION
-- pgcrypto / uuid-ossp is needed here.

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at current on every UPDATE.
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Row trigger: stamps updated_at = now() on every UPDATE. Attached to every table with an updated_at column.';

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, user-editable profile data.
-- ---------------------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text,
  shipping_address jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'User profile data. Primary key is the auth.users id, so a profile disappears when the auth user is deleted.';

create trigger set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- scans: one row per leg-scan capture, driving the pipeline state machine.
-- ---------------------------------------------------------------------------
create table public.scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Deviation from the DESIGN.md sketch: made NOT NULL. Every scan is for a
  -- specific leg from the moment capture starts (the app asks up front), so
  -- there is no valid intermediate state where leg is unknown.
  leg text not null check (leg in ('L', 'R')),
  status text not null default 'capturing'
    check (status in ('capturing', 'uploaded', 'processing', 'ready', 'failed')),
  -- Storage object path in the 'meshes' bucket. Null until upload completes.
  mesh_path text,
  -- Device model, iOS version, capture duration, etc. Free-form by design;
  -- the pipeline never reads capture_meta for measurement logic.
  capture_meta jsonb,
  -- Retention marker (DESIGN 9.3): set when the raw mesh is deleted after
  -- order delivery. mesh_path is left in place as a historical record even
  -- after deletion; mesh_deleted_at is the source of truth for "is it gone".
  mesh_deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.scans is
  'One row per leg scan. status tracks capture/upload only; deeper pipeline progress lives in pipeline_jobs.';
comment on column public.scans.mesh_deleted_at is
  'Set when the raw mesh is purged per the retention policy. mesh_path is retained for history; measurements survive independently.';

create index scans_user_id_idx on public.scans(user_id);

create trigger set_updated_at
  before update on public.scans
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- measurements: versioned extraction output against the frozen 25-var schema.
-- ---------------------------------------------------------------------------
create table public.measurements (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans(id) on delete cascade,
  schema_version text not null,
  extraction_version text not null,
  -- Quoted because VALUES is a reserved SQL keyword; "values" is fine as a
  -- column identifier when quoted, but must stay quoted everywhere it's
  -- referenced (DDL, DML, and client query builders).
  "values" jsonb not null,
  validated boolean not null default false,
  created_at timestamptz not null default now(),
  -- Re-running extraction for the same scan under the same extraction
  -- pipeline version is idempotent: upsert onto this key instead of
  -- accumulating duplicate rows.
  unique (scan_id, extraction_version)
);

comment on table public.measurements is
  'Versioned 25-variable measurement JSON per scan, keyed by extraction_version so re-runs are comparable, not duplicated.';
comment on column public.measurements."values" is
  'The 25-variable measurement payload in millimeters, matching packages/shared JSON Schema exactly (Leg_Length + S1-S4 x 6 dims).';

create index measurements_scan_id_idx on public.measurements(scan_id);

-- ---------------------------------------------------------------------------
-- products: guard models/styles sold in the shop.
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- Deviation: added NOT NULL alongside UNIQUE. A product without a slug
  -- can't be linked to from the shop, so treat it as required.
  slug text not null unique,
  base_price_cents integer not null check (base_price_cents >= 0),
  currency text not null default 'usd',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.products is
  'Guard models/styles available for purchase. Prices in integer cents to avoid float rounding.';

create trigger set_updated_at
  before update on public.products
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- orders: a purchase of one product, tied to one or two scans (per leg).
-- ---------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- ON DELETE RESTRICT: a product or scan that has been ordered must not be
  -- silently removable out from under order history.
  product_id uuid not null references public.products(id) on delete restrict,
  scan_id_left uuid references public.scans(id) on delete restrict,
  scan_id_right uuid references public.scans(id) on delete restrict,
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'paid', 'in_production', 'shipped', 'delivered', 'cancelled')),
  stripe_payment_intent text unique,
  amount_cents integer check (amount_cents >= 0),
  address jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_at_least_one_scan check (scan_id_left is not null or scan_id_right is not null)
);

comment on table public.orders is
  'A purchase of one product for one or two legs. Status transitions are server-side only (payment webhook, admin, worker).';

create index orders_user_id_idx on public.orders(user_id);

create trigger set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- pipeline_jobs: the Postgres-backed job queue driving the scan/order state
-- machine described in DESIGN.md section 6.
-- ---------------------------------------------------------------------------
create table public.pipeline_jobs (
  id uuid primary key default gen_random_uuid(),
  -- Nullable: measuring can happen before an order exists (measurements are
  -- reusable across reorders per DESIGN.md section 5). ON DELETE SET NULL so
  -- a job's history survives even if the order row is later removed.
  order_id uuid references public.orders(id) on delete set null,
  scan_id uuid not null references public.scans(id) on delete cascade,
  step text not null check (step in (
    'captured', 'uploaded', 'measuring', 'measured', 'generating_cad',
    'stl_ready', 'queued_for_print', 'printing', 'shipped', 'failed'
  )),
  status text not null default 'pending'
    check (status in ('pending', 'running', 'succeeded', 'failed', 'dead_letter')),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  error jsonb,
  -- e.g. { "stl_path": "...", "onshape_document_id": "...", "onshape_version_id": "..." }
  artifacts jsonb,
  locked_by text,
  locked_at timestamptz,
  run_after timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.pipeline_jobs is
  'Postgres-backed job queue. One row advances through steps as the worker processes it; claim/advance/fail/complete via the helper functions below, never by hand-rolled UPDATEs, to keep locking consistent.';

-- Supports the claim query's WHERE clause (status = 'pending' AND
-- run_after <= now()) when used for general status/run_after reporting
-- (e.g. an admin dashboard listing jobs by status).
create index pipeline_jobs_claim_idx on public.pipeline_jobs(status, run_after);

-- Partial index actually used by the hot-path claim query below: Postgres
-- will prefer this over the composite index above once status is pinned to
-- 'pending' by the predicate, since it's smaller and matches exactly.
create index pipeline_jobs_pending_idx on public.pipeline_jobs(run_after) where status = 'pending';

create trigger set_updated_at
  before update on public.pipeline_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- pipeline_jobs queue helpers.
--
-- These run as whatever role calls them. In practice that's always the
-- pipeline worker's service_role connection, which already bypasses RLS, so
-- the functions are plain (not SECURITY DEFINER). They exist to centralize
-- the locking pattern (FOR UPDATE SKIP LOCKED) so worker code never writes
-- ad hoc claim queries that could race.
-- ---------------------------------------------------------------------------

-- Atomically claim up to p_limit pending, due jobs for p_worker_id.
-- Safe to call concurrently from many worker processes: SKIP LOCKED means
-- two workers never claim the same row.
create or replace function public.claim_pipeline_job(p_worker_id text, p_limit integer default 1)
returns setof public.pipeline_jobs
language plpgsql
as $$
begin
  return query
  update public.pipeline_jobs
  set status = 'running',
      locked_by = p_worker_id,
      locked_at = now(),
      started_at = coalesce(started_at, now()),
      attempts = attempts + 1,
      updated_at = now()
  where id in (
    select id
    from public.pipeline_jobs
    where status = 'pending'
      and run_after <= now()
    order by run_after
    limit p_limit
    for update skip locked
  )
  returning *;
end;
$$;

comment on function public.claim_pipeline_job(text, integer) is
  'Claim up to p_limit due pending jobs for p_worker_id using FOR UPDATE SKIP LOCKED. Sets status=running and increments attempts.';

-- Move a job to the next step and hand it back to the queue as pending.
-- Call this after a step succeeds but the overall job is not yet done.
create or replace function public.advance_pipeline_job(
  p_id uuid,
  p_next_step text,
  p_artifacts jsonb default null
)
returns public.pipeline_jobs
language plpgsql
as $$
declare
  v_job public.pipeline_jobs;
begin
  update public.pipeline_jobs
  set step = p_next_step,
      status = 'pending',
      locked_by = null,
      locked_at = null,
      run_after = now(),
      artifacts = coalesce(artifacts, '{}'::jsonb) || coalesce(p_artifacts, '{}'::jsonb),
      updated_at = now()
  where id = p_id
  returning * into v_job;
  return v_job;
end;
$$;

comment on function public.advance_pipeline_job(uuid, text, jsonb) is
  'Advance a job to p_next_step, merge p_artifacts into the artifacts column, and release it back to the queue as pending.';

-- Mark a job fully done (its final step succeeded, e.g. reached 'shipped').
create or replace function public.complete_pipeline_job(
  p_id uuid,
  p_artifacts jsonb default null
)
returns public.pipeline_jobs
language plpgsql
as $$
declare
  v_job public.pipeline_jobs;
begin
  update public.pipeline_jobs
  set status = 'succeeded',
      locked_by = null,
      locked_at = null,
      finished_at = now(),
      artifacts = coalesce(artifacts, '{}'::jsonb) || coalesce(p_artifacts, '{}'::jsonb),
      updated_at = now()
  where id = p_id
  returning * into v_job;
  return v_job;
end;
$$;

comment on function public.complete_pipeline_job(uuid, jsonb) is
  'Mark a job fully succeeded (terminal state). Use when the current step is the last one, not for intermediate step transitions.';

-- Record a step failure. Retries with capped exponential backoff
-- (2^attempts minutes, ceiling 60 minutes) until max_attempts is exhausted
-- or the caller marks the failure non-retriable, at which point the job
-- moves to dead_letter for manual/admin triage.
create or replace function public.fail_pipeline_job(
  p_id uuid,
  p_error jsonb,
  p_retriable boolean default true
)
returns public.pipeline_jobs
language plpgsql
as $$
declare
  v_job public.pipeline_jobs;
  v_will_retry boolean;
begin
  select p_retriable and (attempts < max_attempts)
    into v_will_retry
    from public.pipeline_jobs
    where id = p_id;

  update public.pipeline_jobs
  set status = case when v_will_retry then 'pending' else 'dead_letter' end,
      error = p_error,
      locked_by = null,
      locked_at = null,
      run_after = case
        when v_will_retry then now() + (least(power(2, attempts), 60) * interval '1 minute')
        else run_after
      end,
      finished_at = case when v_will_retry then null else now() end,
      updated_at = now()
  where id = p_id
  returning * into v_job;
  return v_job;
end;
$$;

comment on function public.fail_pipeline_job(uuid, jsonb, boolean) is
  'Record a step failure. Retries with capped exponential backoff while attempts < max_attempts and p_retriable; otherwise moves to dead_letter.';

-- ---------------------------------------------------------------------------
-- audit_log: append-only record of admin/service actions (DESIGN 9.8).
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  -- Free-form identifier of who/what performed the action (e.g. an admin
  -- user id, 'worker', 'stripe-webhook'). Not a foreign key on purpose:
  -- audit entries must survive the actor being deleted.
  actor text not null,
  action text not null,
  subject_table text,
  subject_id uuid,
  detail jsonb,
  created_at timestamptz not null default now()
);

comment on table public.audit_log is
  'Append-only log of admin and service actions. No user-facing SELECT policy anywhere; service role / admin API only.';

create index audit_log_subject_idx on public.audit_log(subject_table, subject_id);
