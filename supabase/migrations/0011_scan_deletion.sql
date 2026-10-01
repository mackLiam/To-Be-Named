-- 0011_scan_deletion.sql
-- User-initiated scan deletion (DESIGN.md section 9.3 "delete my scans").
--
-- Clients cannot delete mesh objects (0003: no storage DELETE policy, on
-- purpose), and deleting only the scans row would orphan the body-scan files
-- where the retention sweep can never find them again. So deletion is two
-- steps:
--   1. The app calls request_scan_deletion: deleted_at is stamped and the
--      Library hides the scan at once.
--   2. The purge worker (forms_pipeline.jobs.scan_deletion, service role)
--      erases the storage objects, then deletes the rows; measurements and
--      pipeline_jobs go with them via ON DELETE CASCADE.
--
-- A scan on an order is never purged: production and order history need it,
-- and orders.scan_id_* is ON DELETE RESTRICT anyway. The RPC refuses it up
-- front, and get_scans_pending_purge re-checks, because "scans: update own"
-- (0002) lets a client stamp deleted_at directly and skip the RPC.

alter table public.scans add column deleted_at timestamptz;

comment on column public.scans.deleted_at is
  'Set when the owner asks to delete the scan. Hidden from the app from then on; the purge worker erases its storage objects and the row.';

create index scans_pending_purge_idx on public.scans(deleted_at)
  where deleted_at is not null;

-- ---------------------------------------------------------------------------
-- request_scan_deletion: the app's one entry point. Takes both legs of a
-- session at once so a pair is never half-deleted by a refused second call.
-- Idempotent: ids already purged (row gone) or already stamped are no-ops.
-- ---------------------------------------------------------------------------
create or replace function public.request_scan_deletion(p_scan_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;

  -- One session is at most two legs; anything larger is not this app.
  if p_scan_ids is null or cardinality(p_scan_ids) not between 1 and 2 then
    raise exception 'expected 1 or 2 scan ids' using errcode = 'invalid_parameter_value';
  end if;

  -- Lock the rows first so a concurrent order insert (whose trigger below
  -- takes a share lock on the same rows) is serialized against this check.
  perform 1 from public.scans where id = any(p_scan_ids) for update;

  -- Definer bypasses RLS, so ownership is checked here: every row that still
  -- exists must belong to the caller.
  if exists (
    select 1 from public.scans
    where id = any(p_scan_ids) and user_id <> auth.uid()
  ) then
    raise exception 'not authorized to delete these scans' using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from public.orders
    where scan_id_left = any(p_scan_ids) or scan_id_right = any(p_scan_ids)
  ) then
    raise exception 'scan is on an order' using errcode = 'check_violation';
  end if;

  update public.scans
    set deleted_at = now()
    where id = any(p_scan_ids)
      and user_id = auth.uid()
      and deleted_at is null;

  -- Queued work for a deleted scan is pointless: dead-letter it through the
  -- shared helper (non-retriable) so no worker reconstructs or measures it.
  -- A running job is left to finish; the purge waits for it.
  perform public.fail_pipeline_job(pj.id, '{"reason": "scan_deleted"}'::jsonb, false)
    from public.pipeline_jobs pj
    where pj.scan_id = any(p_scan_ids) and pj.status = 'pending';
end;
$$;

comment on function public.request_scan_deletion(uuid[]) is
  'Owner-only: mark 1-2 scans (one session) for deletion. Refuses scans on an order. Idempotent.';

revoke execute on function public.request_scan_deletion(uuid[]) from public, anon;
grant execute on function public.request_scan_deletion(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- The reverse race: an order must never be placed on a scan the owner has
-- deleted, or production would use data the user asked us to erase.
-- ---------------------------------------------------------------------------
create or replace function public.orders_reject_deleted_scans()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.scans
    where id in (new.scan_id_left, new.scan_id_right)
    for share;
  if exists (
    select 1 from public.scans
    where id in (new.scan_id_left, new.scan_id_right) and deleted_at is not null
  ) then
    raise exception 'scan was deleted by its owner' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.orders_reject_deleted_scans() from public, anon, authenticated;

create trigger orders_reject_deleted_scans
  before insert or update of scan_id_left, scan_id_right on public.orders
  for each row
  execute function public.orders_reject_deleted_scans();

-- ---------------------------------------------------------------------------
-- get_scans_pending_purge: the purge worker's batch. Service-role only: it
-- spans every user and returns storage paths.
-- ---------------------------------------------------------------------------
create or replace function public.get_scans_pending_purge(p_limit integer default 100)
returns table (scan_id uuid, user_id uuid, mesh_path text)
language sql
stable
as $$
  select s.id, s.user_id, s.mesh_path
  from public.scans s
  where s.deleted_at is not null
    and not exists (
      select 1 from public.orders o
      where o.scan_id_left = s.id or o.scan_id_right = s.id
    )
    -- Let an in-flight job finish (or fail) before its inputs vanish.
    and not exists (
      select 1 from public.pipeline_jobs pj
      where pj.scan_id = s.id and pj.status = 'running'
    )
  order by s.deleted_at
  limit p_limit;
$$;

comment on function public.get_scans_pending_purge(integer) is
  'Batch of owner-deleted scans to erase: not on any order, no running job. LIMIT-capped. Service-role only.';

revoke execute on function public.get_scans_pending_purge(integer) from public, anon, authenticated;
grant execute on function public.get_scans_pending_purge(integer) to service_role;
