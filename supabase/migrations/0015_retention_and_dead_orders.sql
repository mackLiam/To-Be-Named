-- 0015_retention_and_dead_orders.sql
-- Body-scan deletion gaps (docs/DESIGN.md section 9.3). Adds or changes:
--   A. order_is_live: an order blocks scan deletion only while it is live.
--      A cancelled order that was never paid (abandoned checkout, 0013) is
--      dead: it holds no money and no production, so it must not keep a
--      minor's body scan alive forever.
--   B. orders_stamp_paid_at: paid_at means "money was ever received" on
--      every path, including the admin manual mark-paid (apps/web shop.ts),
--      which 0013 left without it. Backfills rows that predate this.
--   C. request_scan_deletion (0012), stamp_stray_scans_deleted (0012),
--      get_accounts_pending_deletion (0012), get_scans_pending_purge (0012):
--      "any order" becomes "any live order". stamp_stray_scans_deleted also
--      cancels the user's pending_payment orders first, so a checkout opened
--      after a deletion request cannot stay payable. Otherwise unchanged.
--   D. purge_scan_row: the purge worker's row delete, now also deleting the
--      dead orders that would otherwise block it (orders.scan_id_* is ON
--      DELETE RESTRICT, 0001), audited, in one transaction.
--   E. get_meshes_pending_deletion (0004): retention also erases failed
--      scans, photo scans whose reconstruction failed (no mesh_path) and
--      scans never enqueued, so no raw capture outlives the 30-day promise.
--
-- orders_reject_deleted_scans (0011) is unchanged. Grants follow 0008.
-- Exercised by supabase/tests/retention_dead_orders_checks.sql.

-- ---------------------------------------------------------------------------
-- A. order_is_live
-- No search_path setting: it touches no objects, and a SET clause would stop
-- the planner inlining it into the callers' queries.
-- ---------------------------------------------------------------------------
create function public.order_is_live(p_status text, p_paid_at timestamptz)
returns boolean
language sql
immutable
as $$
  select not (p_status = 'cancelled' and p_paid_at is null);
$$;

comment on function public.order_is_live(text, timestamptz) is
  'False only for a cancelled order that was never paid (paid_at null). Live orders keep their scans; dead ones are purged with them (0015).';

-- Callers are definer functions (run as owner) or service-role invoker ones.
revoke execute on function public.order_is_live(text, timestamptz) from public, anon, authenticated;
grant execute on function public.order_is_live(text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- B. paid_at on every path to paid. Insert too: a service-role insert may
-- create an order already paid. A webhook-set paid_at is never overwritten.
-- ---------------------------------------------------------------------------
create function public.orders_stamp_paid_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'paid' and new.paid_at is null then
    new.paid_at := now();
  end if;
  return new;
end;
$$;

revoke execute on function public.orders_stamp_paid_at() from public, anon, authenticated;

create trigger orders_stamp_paid_at
  before insert or update of status on public.orders
  for each row
  execute function public.orders_stamp_paid_at();

-- Rows marked paid before this trigger existed. Past paid statuses imply
-- payment; a cancelled order counts as paid if the admin audit trail
-- (apps/web shop-writes.ts 'order.status') shows it moved to paid. Without
-- this, such an order would read as dead and be purged with its scan.
-- set_updated_at is paused as in 0012 so history is not rewritten.
alter table public.orders disable trigger set_updated_at;
update public.orders o
  set paid_at = coalesce(
    (select min(a.created_at) from public.audit_log a
      where a.subject_table = 'orders' and a.subject_id = o.id
        and a.action = 'order.status' and a.detail ->> 'to' = 'paid'),
    o.updated_at)
  where o.paid_at is null
    and (o.status in ('paid', 'in_production', 'shipped', 'delivered')
      or exists (
        select 1 from public.audit_log a
        where a.subject_table = 'orders' and a.subject_id = o.id
          and a.action = 'order.status' and a.detail ->> 'to' = 'paid'));
alter table public.orders enable trigger set_updated_at;

-- ---------------------------------------------------------------------------
-- C. 0012 redefinitions: "any order" -> "any live order".
-- ---------------------------------------------------------------------------
create or replace function public.request_scan_deletion(p_scan_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;

  if p_scan_ids is null or cardinality(p_scan_ids) not between 1 and 2 then
    raise exception 'expected 1 or 2 scan ids' using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.scans where id = any(p_scan_ids) for update;

  if exists (
    select 1 from public.scans
    where id = any(p_scan_ids) and user_id is distinct from auth.uid()
  ) then
    raise exception 'not authorized to delete these scans' using errcode = 'insufficient_privilege';
  end if;

  -- Lock the referencing orders too, so a late payment webhook cannot turn
  -- a dead order live between this check and the stamp.
  perform 1 from public.orders
    where scan_id_left = any(p_scan_ids) or scan_id_right = any(p_scan_ids)
    for update;

  if exists (
    select 1 from public.orders
    where (scan_id_left = any(p_scan_ids) or scan_id_right = any(p_scan_ids))
      and public.order_is_live(status, paid_at)
  ) then
    raise exception 'scan is on an order' using errcode = 'check_violation';
  end if;

  update public.scans
    set deleted_at = now()
    where id = any(p_scan_ids)
      and user_id = auth.uid()
      and deleted_at is null;

  perform public.fail_pipeline_job(pj.id, '{"reason": "scan_deleted"}'::jsonb, false)
    from public.pipeline_jobs pj
    where pj.scan_id = any(p_scan_ids) and pj.status = 'pending';
end;
$$;

comment on function public.request_scan_deletion(uuid[]) is
  'Owner-only: mark 1-2 scans (one session) for deletion. Refuses scans on a live order (0015: a cancelled never-paid order does not block). Idempotent.';

revoke execute on function public.request_scan_deletion(uuid[]) from public, anon, authenticated;
grant execute on function public.request_scan_deletion(uuid[]) to authenticated;

create or replace function public.stamp_stray_scans_deleted(p_user_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  perform 1 from public.scans where user_id = p_user_id and deleted_at is null for update;

  -- Every caller is deleting this account. A checkout opened after the
  -- request must not stay payable: cancel it first so its scans count as on
  -- a dead order below. A payment that still lands is recorded for refund by
  -- stripe_checkout_completed (0013), which then makes the order live again.
  update public.orders set status = 'cancelled'
    where user_id = p_user_id and status = 'pending_payment';

  with stamped as (
    update public.scans s
      set deleted_at = now()
      where s.user_id = p_user_id
        and s.deleted_at is null
        and not exists (
          select 1 from public.orders o
          where (o.scan_id_left = s.id or o.scan_id_right = s.id)
            and public.order_is_live(o.status, o.paid_at))
      returning s.id
  )
  select coalesce(array_agg(id), '{}') into v_ids from stamped;

  perform public.fail_pipeline_job(pj.id, '{"reason": "account_deleted"}'::jsonb, false)
    from public.pipeline_jobs pj
    where pj.scan_id = any(v_ids) and pj.status = 'pending';

  return cardinality(v_ids);
end;
$$;

comment on function public.stamp_stray_scans_deleted(uuid) is
  'Cancel a user''s pending_payment orders, then stamp deleted_at on their scans that are on no live order and dead-letter those scans'' pending jobs. Returns the count of scans newly stamped. Service role only.';

revoke execute on function public.stamp_stray_scans_deleted(uuid) from public, anon, authenticated;
grant execute on function public.stamp_stray_scans_deleted(uuid) to service_role;

create or replace function public.get_accounts_pending_deletion(p_limit integer default 100)
returns table (user_id uuid, reason text)
language sql
stable
set search_path = ''
as $$
  select r.user_id, r.reason
  from public.account_deletion_requests r
  -- An owner-deleted scan on a live order is never purged, so it must not
  -- hold the account back (the worker erases its files instead). One whose
  -- orders are all dead is purged first.
  where not exists (
      select 1 from public.scans s
      where s.user_id = r.user_id and s.deleted_at is not null
        and not exists (
          select 1 from public.orders o
          where (o.scan_id_left = s.id or o.scan_id_right = s.id)
            and public.order_is_live(o.status, o.paid_at)))
    and not exists (
      select 1 from public.orders o
      where o.user_id = r.user_id and o.status in ('paid', 'in_production', 'shipped'))
  order by r.requested_at
  limit p_limit;
$$;

comment on function public.get_accounts_pending_deletion(integer) is
  'Deletion requests ready for the auth user to be deleted: no unpurged deleted scan off a live order, no active order. LIMIT-capped. Service role only.';

revoke execute on function public.get_accounts_pending_deletion(integer) from public, anon, authenticated;
grant execute on function public.get_accounts_pending_deletion(integer) to service_role;

create or replace function public.get_scans_pending_purge(p_limit integer default 100)
returns table (scan_id uuid, storage_user_id uuid, mesh_path text)
language sql
stable
set search_path = ''
as $$
  select s.id, s.storage_user_id, s.mesh_path
  from public.scans s
  where s.deleted_at is not null
    and not exists (
      select 1 from public.orders o
      where (o.scan_id_left = s.id or o.scan_id_right = s.id)
        and (public.order_is_live(o.status, o.paid_at)
             -- A dead order cancelled within a day may still have a payable
             -- Stripe session (Stripe's ceiling is 24 hours): keep it, so a
             -- late charge lands on a row the admin can refund (0013).
             or o.updated_at > now() - interval '24 hours')
    )
    and not exists (
      select 1 from public.pipeline_jobs pj
      where pj.scan_id = s.id and pj.status = 'running'
    )
  order by s.deleted_at
  limit p_limit;
$$;

comment on function public.get_scans_pending_purge(integer) is
  'Batch of owner-deleted scans to erase: on no live order and no dead order cancelled in the last 24 hours, no running job. storage_user_id is the storage prefix. LIMIT-capped. Service role only.';

revoke execute on function public.get_scans_pending_purge(integer) from public, anon, authenticated;
grant execute on function public.get_scans_pending_purge(integer) to service_role;

-- ---------------------------------------------------------------------------
-- D. purge_scan_row: called by the purge worker after storage is erased.
-- Definer so it can delete orders, which the worker otherwise never writes.
-- Returns false, changing nothing, when not eligible; a repeat is false.
-- ---------------------------------------------------------------------------
create function public.purge_scan_row(p_scan_id uuid, p_actor text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
begin
  -- Same lock order as request_scan_deletion: scan, then its orders. The
  -- order lock serializes against a late payment webhook (0013) setting
  -- paid_at, which would make the order live again.
  perform 1 from public.scans where id = p_scan_id and deleted_at is not null for update;
  if not found then
    return false;
  end if;

  perform 1 from public.orders
    where scan_id_left = p_scan_id or scan_id_right = p_scan_id
    for update;

  -- Same eligibility as get_scans_pending_purge, re-checked under the locks:
  -- no live order, no dead order cancelled within a day, no running job.
  if exists (
    select 1 from public.orders
    where (scan_id_left = p_scan_id or scan_id_right = p_scan_id)
      and (public.order_is_live(status, paid_at) or updated_at > now() - interval '24 hours')
  ) or exists (
    select 1 from public.pipeline_jobs where scan_id = p_scan_id and status = 'running'
  ) then
    return false;
  end if;

  -- Only dead orders remain: cancelled with paid_at null, never a financial
  -- record. The filter is repeated so a live order can never be deleted here
  -- (RESTRICT fails the call instead). A pair order also names the other
  -- leg; it goes too, and that leg's own deletion state is unaffected.
  for v_order_id in
    delete from public.orders
      where (scan_id_left = p_scan_id or scan_id_right = p_scan_id)
        and not public.order_is_live(status, paid_at)
      returning id
  loop
    insert into public.audit_log (actor, action, subject_table, subject_id)
    values (p_actor, 'order_purged_with_scan', 'orders', v_order_id);
  end loop;

  -- measurements and pipeline_jobs cascade (0001).
  delete from public.scans where id = p_scan_id;

  insert into public.audit_log (actor, action, subject_table, subject_id)
  values (p_actor, 'scan_purged', 'scans', p_scan_id);

  return true;
end;
$$;

comment on function public.purge_scan_row(uuid, text) is
  'Purge worker: delete an owner-deleted scan row on no live order, with its dead (cancelled, never paid) orders. Audited. False and no change when not eligible. Service role only.';

revoke execute on function public.purge_scan_row(uuid, text) from public, anon, authenticated;
grant execute on function public.purge_scan_row(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- E. get_meshes_pending_deletion (0004, grants 0008). Same signature and
-- columns. The clock starts at the last terminal job (succeeded or
-- dead_letter), or at scan creation when no job ever finished (never
-- enqueued). Photo scans may have no mesh_path: their objects live under
-- <storage_user_id>/<scan_id>/ and the worker erases that prefix. Manual
-- scans (0014) have no objects at all.
-- ---------------------------------------------------------------------------
create or replace function public.get_meshes_pending_deletion(
  p_retention_days integer default 30,
  p_limit integer default 100
)
returns table (scan_id uuid, mesh_path text, job_completed_at timestamptz)
language sql
stable
as $$
  select s.id as scan_id, s.mesh_path, agg.completed_at as job_completed_at
  from public.scans s
  cross join lateral (
    select
      coalesce(
        max(pj.finished_at) filter (where pj.status in ('succeeded', 'dead_letter')),
        s.created_at) as completed_at,
      coalesce(bool_or(pj.status in ('pending', 'running')), false) as has_active_job
    from public.pipeline_jobs pj
    where pj.scan_id = s.id
  ) agg
  where s.mesh_deleted_at is null
    and s.capture_kind <> 'manual'
    and (s.mesh_path is not null or s.capture_kind = 'photos')
    and not agg.has_active_job
    and agg.completed_at <= now() - make_interval(days => p_retention_days)
  order by agg.completed_at
  limit p_limit;
$$;

comment on function public.get_meshes_pending_deletion(integer, integer) is
  'Batch of scans whose raw capture is due for deletion: has storage objects (mesh_path, or a photos bundle), no pending/running job, more than p_retention_days since the last succeeded/dead_letter job or, with none, since creation. mesh_path may be null for photos scans. LIMIT-capped. Service role only.';

revoke execute on function public.get_meshes_pending_deletion(integer, integer) from public, anon, authenticated;
grant execute on function public.get_meshes_pending_deletion(integer, integer) to service_role;
