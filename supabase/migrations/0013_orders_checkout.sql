-- 0013_orders_checkout.sql
-- Stripe checkout, scan status driven by the pipeline, and the lock-downs
-- that both need. docs/DESIGN.md sections 6 (pipeline state machine),
-- 8 (data model) and 9 (security and privacy). Adds:
--   - orders: stripe_checkout_session_id, paid_at, refunded_at.
--   - stripe_events: ledger of processed Stripe event ids, so a redelivered
--     webhook never double-applies (closes the README "Stripe webhook
--     idempotency table" TODO).
--   - stripe_checkout_completed / stripe_checkout_expired /
--     stripe_charge_refunded: one RPC per webhook event. Each records the
--     event and applies its effect in the same transaction, so an event is
--     never marked seen without its effect (a failed apply rolls back the
--     ledger row too and Stripe's retry gets a clean second attempt).
--   - Cancelling an order dead-letters its queued CAD jobs.
--   - scans.status follows the measure job (processing / ready / failed,
--     with failed_step). Before this nothing moved a scan past 'uploaded'.
--   - Clients can no longer drive scans.status, failed_step or
--     mesh_deleted_at through "scans: update own" (0002).
--   - enqueue_measure_job stays idempotent now that the first call moves the
--     scan out of 'uploaded'.
--   - products.cad_model hidden from anon/authenticated (internal CAD refs);
--     this supersedes the "safe to expose" note in 0006.
--   - retry_pipeline_job: admin dead-letter retry.
--   - waitlist: marketing-site signups, server-written only.
--
-- Grants follow 0008: every new function revokes execute from public, anon
-- and authenticated, then grants only the intended role.
--
-- Exercised by supabase/tests/orders_checkout_checks.sql.

-- ---------------------------------------------------------------------------
-- A. orders: Stripe checkout columns
-- ---------------------------------------------------------------------------
alter table public.orders
  add column stripe_checkout_session_id text unique,
  add column paid_at timestamptz,
  add column refunded_at timestamptz;

comment on column public.orders.stripe_checkout_session_id is
  'Stripe Checkout Session id (cs_...) created for this order. The completed/expired webhooks find the order by it.';
comment on column public.orders.paid_at is
  'When Stripe reported the payment (checkout.session.completed). Normally the moment the order became paid; on an order cancelled while the customer was paying, marks money that must be refunded. Set only by stripe_checkout_completed.';
comment on column public.orders.refunded_at is
  'When the charge was fully refunded. Partial refunds leave it null (audit_log only). Does not change status: an admin decides.';

-- ---------------------------------------------------------------------------
-- B. stripe_events: processed-event ledger. Service role only.
-- ---------------------------------------------------------------------------
create table public.stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);

comment on table public.stripe_events is
  'Stripe event ids (evt_...) already applied. Written only inside the stripe_* webhook RPCs, in the same transaction as the effect.';

alter table public.stripe_events enable row level security;
revoke all on public.stripe_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- C. Webhook RPCs. Return 'applied' | 'duplicate' | 'ignored'.
-- 'ignored' still records the event: redelivery of an event that did not
-- match an order would not match next time either.
-- ---------------------------------------------------------------------------
create function public.stripe_checkout_completed(
  p_event_id text,
  p_session_id text,
  p_payment_intent text,
  p_amount_cents integer,
  p_currency text,
  p_address jsonb
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_product_currency text;
  v_outcome text;
begin
  insert into public.stripe_events (id, type)
  values (p_event_id, 'checkout.session.completed')
  on conflict (id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  select * into v_order
    from public.orders
    where stripe_checkout_session_id = p_session_id
    for update;

  if found and v_order.status = 'pending_payment' then
    -- orders_enqueue_cad (0008) fires on this update; if it raises, the whole
    -- call (including the ledger row) rolls back and Stripe retries.
    update public.orders
      set status = 'paid',
          paid_at = now(),
          amount_cents = p_amount_cents,
          stripe_payment_intent = p_payment_intent,
          address = p_address
      where id = v_order.id;
    v_outcome := 'applied';
  elsif found and v_order.status = 'cancelled' and v_order.stripe_payment_intent is null then
    -- Paid after an admin or account deletion cancelled the pending order:
    -- the customer was charged, so record the payment where the admin
    -- refund path looks for it. Status stays cancelled; no CAD runs.
    update public.orders
      set paid_at = now(),
          amount_cents = p_amount_cents,
          stripe_payment_intent = p_payment_intent
      where id = v_order.id;
    v_outcome := 'ignored';
  else
    v_outcome := 'ignored';
  end if;

  select currency into v_product_currency from public.products where id = v_order.product_id;

  insert into public.audit_log (actor, action, subject_table, subject_id, detail)
  values ('stripe-webhook', 'stripe.checkout.session.completed', 'orders', v_order.id,
    jsonb_build_object(
      'event_id', p_event_id,
      'outcome', v_outcome,
      'session_id', p_session_id,
      'order_status', v_order.status,
      'needs_refund', v_order.status = 'cancelled',
      'expected_amount_cents', v_order.amount_cents,
      'charged_amount_cents', p_amount_cents,
      'expected_currency', v_product_currency,
      'charged_currency', p_currency));

  return v_outcome;
end;
$$;

comment on function public.stripe_checkout_completed(text, text, text, integer, text, jsonb) is
  'Webhook: checkout.session.completed. Idempotent on p_event_id. pending_payment order -> paid (enqueues CAD via orders_enqueue_cad). Service role only.';

revoke execute on function public.stripe_checkout_completed(text, text, text, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.stripe_checkout_completed(text, text, text, integer, text, jsonb) to service_role;

create function public.stripe_checkout_expired(p_event_id text, p_session_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_outcome text;
begin
  insert into public.stripe_events (id, type)
  values (p_event_id, 'checkout.session.expired')
  on conflict (id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  select * into v_order
    from public.orders
    where stripe_checkout_session_id = p_session_id
    for update;

  if found and v_order.status = 'pending_payment' then
    update public.orders set status = 'cancelled' where id = v_order.id;
    v_outcome := 'applied';
  else
    v_outcome := 'ignored';
  end if;

  insert into public.audit_log (actor, action, subject_table, subject_id, detail)
  values ('stripe-webhook', 'stripe.checkout.session.expired', 'orders', v_order.id,
    jsonb_build_object(
      'event_id', p_event_id,
      'outcome', v_outcome,
      'session_id', p_session_id,
      'order_status', v_order.status));

  return v_outcome;
end;
$$;

comment on function public.stripe_checkout_expired(text, text) is
  'Webhook: checkout.session.expired. Idempotent on p_event_id. pending_payment order -> cancelled. Service role only.';

revoke execute on function public.stripe_checkout_expired(text, text) from public, anon, authenticated;
grant execute on function public.stripe_checkout_expired(text, text) to service_role;

create function public.stripe_charge_refunded(
  p_event_id text,
  p_payment_intent text,
  p_fully_refunded boolean
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_outcome text;
begin
  insert into public.stripe_events (id, type)
  values (p_event_id, 'charge.refunded')
  on conflict (id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  select * into v_order
    from public.orders
    where stripe_payment_intent = p_payment_intent
    for update;

  if found then
    -- Status is left alone: whether a refunded order stops production is an
    -- admin call, not something a webhook infers.
    if p_fully_refunded then
      update public.orders
        set refunded_at = coalesce(refunded_at, now())
        where id = v_order.id;
    end if;
    v_outcome := 'applied';
  else
    v_outcome := 'ignored';
  end if;

  insert into public.audit_log (actor, action, subject_table, subject_id, detail)
  values ('stripe-webhook', 'stripe.charge.refunded', 'orders', v_order.id,
    jsonb_build_object(
      'event_id', p_event_id,
      'outcome', v_outcome,
      'payment_intent', p_payment_intent,
      'fully_refunded', p_fully_refunded,
      'order_status', v_order.status));

  return v_outcome;
end;
$$;

comment on function public.stripe_charge_refunded(text, text, boolean) is
  'Webhook: charge.refunded. Idempotent on p_event_id. Full refund stamps refunded_at; partial is audit-only. Never changes status. Service role only.';

revoke execute on function public.stripe_charge_refunded(text, text, boolean) from public, anon, authenticated;
grant execute on function public.stripe_charge_refunded(text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- D. Cancelling an order dead-letters its queued CAD jobs (each one copies
-- the Onshape template, DESIGN.md section 7). A running job is left to
-- finish; its output is simply never shipped.
-- ---------------------------------------------------------------------------
create function public.orders_cancel_pending_jobs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.fail_pipeline_job(pj.id, '{"reason":"order_cancelled"}'::jsonb, false)
    from public.pipeline_jobs pj
    where pj.order_id = new.id and pj.status = 'pending';
  return new;
end;
$$;

revoke execute on function public.orders_cancel_pending_jobs() from public, anon, authenticated;

create trigger orders_cancel_pending_jobs
  after update of status on public.orders
  for each row
  when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function public.orders_cancel_pending_jobs();

-- ---------------------------------------------------------------------------
-- E. scans.status follows the measure job.
-- ---------------------------------------------------------------------------
alter table public.scans
  add column failed_step text
    constraint scans_failed_step_check check (failed_step is null or failed_step in ('reconstructing', 'measuring'));

comment on column public.scans.failed_step is
  'Measure-job step that dead-lettered (reconstructing or measuring) when status = failed; null otherwise. Set only by the pipeline_jobs_sync_scan_status trigger.';

create function public.pipeline_jobs_sync_scan_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 'capturing' is excluded: a job for a scan whose upload has not finished
  -- must not make the app show progress for a mesh that is not there.
  if new.status in ('pending', 'running') then
    update public.scans
      set status = 'processing', failed_step = null
      where id = new.scan_id and status <> 'capturing';
  elsif new.status = 'succeeded' then
    update public.scans
      set status = 'ready', failed_step = null
      where id = new.scan_id;
  elsif new.status = 'dead_letter' then
    update public.scans
      set status = 'failed',
          failed_step = case when new.step in ('reconstructing', 'measuring') then new.step else null end
      where id = new.scan_id;
  end if;
  return null;
end;
$$;

revoke execute on function public.pipeline_jobs_sync_scan_status() from public, anon, authenticated;

-- Measure jobs only: a CAD job's outcome belongs to its order, not the scan.
create trigger pipeline_jobs_sync_scan_status
  after insert or update of status on public.pipeline_jobs
  for each row
  when (new.product_id is null)
  execute function public.pipeline_jobs_sync_scan_status();

-- ---------------------------------------------------------------------------
-- F. Clients cannot drive scan status. SECURITY INVOKER on purpose: it keys
-- on current_user, which inside a definer function (enqueue_measure_job,
-- request_scan_deletion, the E trigger) is the owner, not the client role,
-- so server-side paths are unaffected.
-- ---------------------------------------------------------------------------
create function public.scans_guard_client_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status not in ('capturing', 'uploaded') then
      raise exception 'clients may only create scans as capturing or uploaded (got %)', new.status
        using errcode = 'check_violation';
    end if;
    new.failed_step := null;
    new.mesh_deleted_at := null;
  else
    -- Coerce rather than raise: the app's upload retry re-upserts the row
    -- with status 'uploaded' after the measure job has moved it on, and that
    -- retry must keep succeeding.
    if not (old.status = 'capturing' and new.status = 'uploaded') then
      new.status := old.status;
    end if;
    new.failed_step := old.failed_step;
    new.mesh_deleted_at := old.mesh_deleted_at;
  end if;
  return new;
end;
$$;

revoke execute on function public.scans_guard_client_status() from public, anon, authenticated;

create trigger scans_guard_client_status
  before insert or update on public.scans
  for each row
  execute function public.scans_guard_client_status();

-- ---------------------------------------------------------------------------
-- G. enqueue_measure_job: idempotent past 'uploaded'. Same as 0008 plus the
-- processing/ready/failed branch.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_measure_job(p_scan_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_status text;
  v_kind text;
  v_job_id uuid;
begin
  -- Definer function bypasses RLS: it must verify the caller itself.
  select user_id, status, capture_kind
    into v_owner, v_status, v_kind
    from public.scans
    where id = p_scan_id;

  if v_owner is null then
    raise exception 'scan % not found', p_scan_id
      using errcode = 'no_data_found';
  end if;

  -- `is distinct from` so a null auth.uid() (no session) is refused too.
  if v_owner is distinct from auth.uid() then
    raise exception 'not authorized to enqueue scan %', p_scan_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Already enqueued once (the E trigger moved the scan on): an upload retry
  -- gets the existing job back instead of an error or a second job.
  if v_status in ('processing', 'ready', 'failed') then
    select id
      into v_job_id
      from public.pipeline_jobs
      where scan_id = p_scan_id
        and product_id is null
      order by created_at desc
      limit 1;
    return v_job_id;
  end if;

  if v_status <> 'uploaded' then
    raise exception 'scan % is not uploaded (status=%)', p_scan_id, v_status
      using errcode = 'check_violation';
  end if;

  insert into public.pipeline_jobs (scan_id, step, status)
  values (
    p_scan_id,
    case when v_kind = 'photos' then 'reconstructing' else 'measuring' end,
    'pending'
  )
  on conflict (scan_id) where status in ('pending', 'running') and product_id is null
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
    -- An active measure job already exists (retry or concurrent caller).
    select id
      into v_job_id
      from public.pipeline_jobs
      where scan_id = p_scan_id
        and product_id is null
        and status in ('pending', 'running')
      order by created_at
      limit 1;
  end if;

  return v_job_id;
end;
$$;

comment on function public.enqueue_measure_job(uuid) is
  'Client-callable (authenticated) SECURITY DEFINER RPC: enqueue the measure job for a scan the caller owns (photos scans start at reconstructing, mesh scans at measuring). Verifies auth.uid() ownership. Uploaded: inserts or returns the active measure job. Processing/ready/failed: returns the latest measure job without inserting. Capturing: refused.';

revoke execute on function public.enqueue_measure_job(uuid) from public, anon;
grant execute on function public.enqueue_measure_job(uuid) to authenticated;
grant execute on function public.enqueue_measure_job(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- H. products: cad_model holds internal CAD document refs, so clients get a
-- column-level grant without it. "products: select all" (0002) is unchanged.
-- ---------------------------------------------------------------------------
revoke select on public.products from anon, authenticated;
grant select (id, name, slug, description, base_price_cents, currency, active, image_url, created_at, updated_at)
  on public.products to anon, authenticated;

-- ---------------------------------------------------------------------------
-- I. retry_pipeline_job: admin dead-letter retry. Service role only.
-- ---------------------------------------------------------------------------
create function public.retry_pipeline_job(p_id uuid, p_actor text)
returns public.pipeline_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.pipeline_jobs;
  v_prev_error jsonb;
begin
  select * into v_job from public.pipeline_jobs where id = p_id for update;
  v_prev_error := v_job.error;

  if not found or v_job.status <> 'dead_letter' then
    raise exception 'job % is not dead-lettered', p_id
      using errcode = 'check_violation';
  end if;

  -- Never resurrect work the owner asked us to erase (0011) or the customer
  -- cancelled (trigger D dead-lettered it on purpose).
  if exists (select 1 from public.scans where id = v_job.scan_id and deleted_at is not null) then
    raise exception 'scan % was deleted by its owner', v_job.scan_id
      using errcode = 'check_violation';
  end if;

  if v_job.order_id is not null
     and exists (select 1 from public.orders where id = v_job.order_id and status = 'cancelled') then
    raise exception 'order % is cancelled', v_job.order_id
      using errcode = 'check_violation';
  end if;

  -- A unique_violation here means another active job already covers this
  -- scan (0008 partial indexes); it propagates so the admin sees it.
  update public.pipeline_jobs
    set status = 'pending',
        attempts = 0,
        run_after = now(),
        finished_at = null,
        locked_by = null,
        locked_at = null,
        error = null
    where id = p_id
    returning * into v_job;

  insert into public.audit_log (actor, action, subject_table, subject_id, detail)
  values (p_actor, 'pipeline_job.retry', 'pipeline_jobs', p_id,
    jsonb_build_object('previous_error', v_prev_error, 'step', v_job.step));

  return v_job;
end;
$$;

comment on function public.retry_pipeline_job(uuid, text) is
  'Admin: return a dead_letter job to pending at the step it failed (attempts reset). Refuses deleted scans and cancelled orders. Audited. Service role only.';

revoke execute on function public.retry_pipeline_job(uuid, text) from public, anon, authenticated;
grant execute on function public.retry_pipeline_job(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- J. waitlist: marketing-site signups, written by the server (service role).
-- ---------------------------------------------------------------------------
create table public.waitlist (
  id bigint generated always as identity primary key,
  -- 320 is the RFC 5321 maximum address length.
  email text not null check (length(email) between 3 and 320 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  interest text not null default 'launch' check (interest in ('launch', 'pro', 'junior_max')),
  created_at timestamptz not null default now()
);

comment on table public.waitlist is
  'Marketing-site waitlist. Written only by the web server with the service role; no client access.';

create unique index waitlist_email_interest_uq on public.waitlist (lower(email), interest);

alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;
