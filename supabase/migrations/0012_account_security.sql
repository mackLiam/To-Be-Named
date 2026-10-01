-- ---------------------------------------------------------------------------
-- 0012: account security. Payment needs a member, guest-to-member merge,
-- account deletion, abandoned-guest cleanup, data export.
--
-- docs/DESIGN.md sections 8 (data model) and 9 (security and privacy: 9.3
-- "full account deletion", 9.5 payments). Adds:
--   A. scans.storage_user_id: the storage prefix owner, pinned at insert and
--      immutable. Rows may change owner (merge) or lose it (account deletion
--      keeps ordered scans) without orphaning their objects, so every worker
--      path that builds a storage path uses it, never user_id. The same
--      trigger freezes deleted_at once set (no client un-delete).
--   B. scans/orders user_id nullable, FK ON DELETE SET NULL: deleting the
--      auth user keeps order records and ordered scans.
--   C. RLS: no client delete of scans rows (0011 header: deletion must go
--      through the RPC); mesh_path confined to the storage prefix; orders
--      insertable only by a member, only as an unpaid shell on the caller's
--      own live scans (status, amount and payment fields are server-set).
--   D. guest_transfers + begin/claim_guest_transfer: single-use token that
--      moves a guest's scans and orders into an existing member account.
--   E. account_deletion_requests + request_account_deletion and the
--      service-role worker helpers (pending accounts, mesh erase, stray scan
--      stamping, abandoned-guest sweep).
--   F. export_my_data: the caller's stored rows as one JSON document.
--   G. request_scan_deletion (0011) refuses ownerless rows;
--      get_scans_pending_purge (0011) returns storage_user_id.
--
-- New functions use `set search_path = ''` with fully qualified names.
-- Grants follow 0008: revoke from public, anon (and authenticated for
-- service-only), then grant the intended role.
--
-- SQLSTATEs are part of the client contract: 42501 not allowed for this
-- caller, 22023 bad or stale input, 23514 refused by current state.
--
-- Exercised by supabase/tests/account_security_checks.sql.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A. scans.storage_user_id
-- No FK: it must outlive the auth user (D3).
-- ---------------------------------------------------------------------------
alter table public.scans add column storage_user_id uuid;

-- Backfill before the pin trigger exists (the trigger would keep the old,
-- null value on update). set_updated_at is paused so the backfill does not
-- rewrite every row's updated_at.
alter table public.scans disable trigger set_updated_at;
update public.scans set storage_user_id = user_id;
alter table public.scans enable trigger set_updated_at;

alter table public.scans alter column storage_user_id set not null;

comment on column public.scans.storage_user_id is
  'Owner of the storage prefix (meshes/<storage_user_id>/...). Set from user_id at insert by scans_pin_owner_fields and never changed, so merged or ownerless rows still locate their objects.';

create function public.scans_pin_owner_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.storage_user_id := new.user_id;
  else
    new.storage_user_id := old.storage_user_id;
    -- Once the owner (or an account deletion) stamps deleted_at, the purge
    -- owns the row; nothing may clear or move the stamp.
    if old.deleted_at is not null then
      new.deleted_at := old.deleted_at;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.scans_pin_owner_fields() from public, anon, authenticated;

create trigger scans_pin_owner_fields
  before insert or update on public.scans
  for each row
  execute function public.scans_pin_owner_fields();

-- ---------------------------------------------------------------------------
-- B. Ownership survives the auth user (D4).
-- ---------------------------------------------------------------------------
alter table public.scans
  alter column user_id drop not null,
  drop constraint scans_user_id_fkey,
  add constraint scans_user_id_fkey foreign key (user_id) references auth.users(id) on delete set null;

alter table public.orders
  alter column user_id drop not null,
  drop constraint orders_user_id_fkey,
  add constraint orders_user_id_fkey foreign key (user_id) references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------------
-- C. RLS changes (policies from 0002).
-- ---------------------------------------------------------------------------
drop policy "scans: delete own" on public.scans;

-- WITH CHECK runs after the BEFORE triggers, so storage_user_id here is the
-- pinned value, never a client-supplied one.
alter policy "scans: insert own" on public.scans
  with check (
    user_id = auth.uid()
    and (mesh_path is null or split_part(mesh_path, '/', 1) = storage_user_id::text)
  );

alter policy "scans: update own" on public.scans
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (mesh_path is null or split_part(mesh_path, '/', 1) = storage_user_id::text)
  );

-- No new orders once the caller has asked for account deletion. Definer so
-- the policy can see account_deletion_requests (section E), which clients
-- cannot read; plpgsql so the body resolves that table at call time.
create function public.account_deletion_pending()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return exists (
    select 1 from public.account_deletion_requests where user_id = auth.uid());
end;
$$;

revoke execute on function public.account_deletion_pending() from public, anon;
grant execute on function public.account_deletion_pending() to authenticated;

-- Payment needs an account (D1). A missing is_anonymous claim counts as a
-- guest. The scan subqueries also run under "scans: select own".
drop policy "orders: insert own" on public.orders;

create policy "orders: members insert pending own"
on public.orders for insert
to authenticated
with check (
  user_id = auth.uid()
  and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, true) = false
  and status = 'pending_payment'
  and stripe_payment_intent is null
  and amount_cents is null
  and tracking_carrier is null
  and tracking_number is null
  and not public.account_deletion_pending()
  and (scan_id_left is null or exists (
    select 1 from public.scans s
    where s.id = scan_id_left and s.user_id = auth.uid() and s.leg = 'L' and s.deleted_at is null))
  and (scan_id_right is null or exists (
    select 1 from public.scans s
    where s.id = scan_id_right and s.user_id = auth.uid() and s.leg = 'R' and s.deleted_at is null))
);

-- ---------------------------------------------------------------------------
-- D. Guest to existing member merge (D2). Tokens are stored hashed; the
-- table is reachable only through the definer functions below.
-- ---------------------------------------------------------------------------
create table public.guest_transfers (
  token_hash bytea primary key,
  guest_user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '10 minutes'
);

comment on table public.guest_transfers is
  'Single-use guest merge tokens, sha256 of the token text. No policies: begin/claim_guest_transfer only.';

alter table public.guest_transfers enable row level security;
revoke all on public.guest_transfers from anon, authenticated;

create function public.begin_guest_transfer()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_token text;
begin
  -- Both the session claim and the stored user must be anonymous: a guest
  -- that upgraded keeps an anonymous JWT until it refreshes.
  if v_uid is null
     or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is not true
     or not exists (select 1 from auth.users u where u.id = v_uid and u.is_anonymous) then
    raise exception 'only a guest can start a transfer' using errcode = 'insufficient_privilege';
  end if;

  delete from public.guest_transfers
    where guest_user_id = v_uid or expires_at <= now();

  -- Two v4 uuids: 244 random bits.
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into public.guest_transfers (token_hash, guest_user_id)
  values (sha256(convert_to(v_token, 'UTF8')), v_uid);

  return v_token;
end;
$$;

comment on function public.begin_guest_transfer() is
  'Guest only: issue a 10-minute single-use token that lets a member claim this guest''s scans and orders. Replaces any earlier token of the caller.';

revoke execute on function public.begin_guest_transfer() from public, anon;
grant execute on function public.begin_guest_transfer() to authenticated;

create function public.claim_guest_transfer(p_token text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_guest uuid;
  v_moved integer;
begin
  if v_uid is null
     or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, true) is not false
     or not exists (select 1 from auth.users u where u.id = v_uid and not u.is_anonymous) then
    raise exception 'only a member can claim a transfer' using errcode = 'insufficient_privilege';
  end if;

  -- One statement consumes the token, so two concurrent claims cannot both
  -- win. A raise below rolls the delete back; the token then just expires.
  delete from public.guest_transfers
    where token_hash = sha256(convert_to(p_token, 'UTF8')) and expires_at > now()
    returning guest_user_id into v_guest;

  if v_guest is null then
    raise exception 'transfer token is invalid or expired' using errcode = 'invalid_parameter_value';
  end if;

  if v_guest = v_uid
     or not exists (select 1 from auth.users u where u.id = v_guest and u.is_anonymous) then
    raise exception 'transfer token no longer belongs to a guest' using errcode = 'invalid_parameter_value';
  end if;

  -- An unfinished capture would upload into the guest prefix from a session
  -- that is about to be retired; drop it instead (purge erases it by
  -- storage_user_id).
  update public.scans
    set deleted_at = now()
    where user_id = v_guest and status = 'capturing' and deleted_at is null;

  update public.scans
    set user_id = v_uid
    where user_id = v_guest and status <> 'capturing';
  get diagnostics v_moved = row_count;

  update public.orders set user_id = v_uid where user_id = v_guest;

  insert into public.account_deletion_requests (user_id, reason)
  values (v_guest, 'merged_guest')
  on conflict (user_id) do nothing;

  return v_moved;
end;
$$;

comment on function public.claim_guest_transfer(text) is
  'Member only: consume a guest transfer token, move the guest''s scans (except unfinished captures, which are deleted) and orders to the caller, queue the guest for deletion. Returns scans moved.';

revoke execute on function public.claim_guest_transfer(text) from public, anon;
grant execute on function public.claim_guest_transfer(text) to authenticated;

-- ---------------------------------------------------------------------------
-- E. Account deletion (D4, D5; App Store 5.1.1(v), GDPR erasure). Requests
-- are processed by the service-role worker, armed explicitly (playbook
-- rule 5): purge deleted scans (0011), erase meshes of kept ordered scans,
-- then delete the auth user (B keeps orders and ordered scans, ownerless).
-- ---------------------------------------------------------------------------
create table public.account_deletion_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  reason text not null check (reason in ('user_request', 'abandoned_guest', 'merged_guest')),
  requested_at timestamptz not null default now()
);

comment on table public.account_deletion_requests is
  'Accounts queued for deletion. No policies: written by definer RPCs, read by the service-role worker. The row goes with the auth user.';

alter table public.account_deletion_requests enable row level security;
revoke all on public.account_deletion_requests from anon, authenticated;

-- Shared by request_account_deletion, queue_abandoned_guests and the worker
-- (new scans created after a request). Scans on an order are kept (0011).
create function public.stamp_stray_scans_deleted(p_user_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  -- Serialize against a concurrent order insert, as in 0011.
  perform 1 from public.scans where user_id = p_user_id and deleted_at is null for update;

  with stamped as (
    update public.scans s
      set deleted_at = now()
      where s.user_id = p_user_id
        and s.deleted_at is null
        and not exists (
          select 1 from public.orders o
          where o.scan_id_left = s.id or o.scan_id_right = s.id)
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
  'Stamp deleted_at on a user''s scans that are on no order and dead-letter their pending jobs. Returns the count stamped. Service role only.';

revoke execute on function public.stamp_stray_scans_deleted(uuid) from public, anon, authenticated;
grant execute on function public.stamp_stray_scans_deleted(uuid) to service_role;

create function public.request_account_deletion()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;

  -- Lock the caller's orders so a payment webhook cannot move one to paid
  -- between this check and the cancel below.
  perform 1 from public.orders where user_id = v_uid for update;

  if exists (
    select 1 from public.orders
    where user_id = v_uid and status in ('paid', 'in_production', 'shipped')
  ) then
    raise exception 'an order is in progress' using errcode = 'check_violation';
  end if;

  update public.orders set status = 'cancelled'
    where user_id = v_uid and status = 'pending_payment';

  perform public.stamp_stray_scans_deleted(v_uid);

  insert into public.account_deletion_requests (user_id, reason)
  values (v_uid, 'user_request')
  on conflict (user_id) do nothing;
end;
$$;

comment on function public.request_account_deletion() is
  'Guest or member: queue the caller''s account for deletion. Refused (23514) while an order is paid, in production or shipped. Cancels unpaid orders and deletes unordered scans. Idempotent.';

revoke execute on function public.request_account_deletion() from public, anon;
grant execute on function public.request_account_deletion() to authenticated;

-- Ready = every owner-deleted scan is purged and no order is still being
-- fulfilled.
create function public.get_accounts_pending_deletion(p_limit integer default 100)
returns table (user_id uuid, reason text)
language sql
stable
set search_path = ''
as $$
  select r.user_id, r.reason
  from public.account_deletion_requests r
  -- An owner-deleted scan that is on an order is never purged (0011), so it
  -- must not hold the account back; the worker erases its files instead.
  where not exists (
      select 1 from public.scans s
      where s.user_id = r.user_id and s.deleted_at is not null
        and not exists (
          select 1 from public.orders o
          where o.scan_id_left = s.id or o.scan_id_right = s.id))
    and not exists (
      select 1 from public.orders o
      where o.user_id = r.user_id and o.status in ('paid', 'in_production', 'shipped'))
  order by r.requested_at
  limit p_limit;
$$;

comment on function public.get_accounts_pending_deletion(integer) is
  'Deletion requests ready for the auth user to be deleted: no unpurged deleted scans, no active order. LIMIT-capped. Service role only.';

revoke execute on function public.get_accounts_pending_deletion(integer) from public, anon, authenticated;
grant execute on function public.get_accounts_pending_deletion(integer) to service_role;

create function public.get_account_meshes_to_erase(p_user_id uuid)
returns table (scan_id uuid, storage_user_id uuid, mesh_path text)
language sql
stable
set search_path = ''
as $$
  select s.id, s.storage_user_id, s.mesh_path
  from public.scans s
  where s.user_id = p_user_id
    and s.mesh_deleted_at is null;
$$;

comment on function public.get_account_meshes_to_erase(uuid) is
  'Kept (ordered) scans of an account being deleted whose storage objects are not yet erased. Service role only.';

revoke execute on function public.get_account_meshes_to_erase(uuid) from public, anon, authenticated;
grant execute on function public.get_account_meshes_to_erase(uuid) to service_role;

create function public.mark_mesh_erased(p_scan_id uuid)
returns void
language sql
set search_path = ''
as $$
  update public.scans set mesh_deleted_at = now()
  where id = p_scan_id and mesh_deleted_at is null;
$$;

comment on function public.mark_mesh_erased(uuid) is
  'Record that a scan''s storage objects were erased. Idempotent. Service role only.';

revoke execute on function public.mark_mesh_erased(uuid) from public, anon, authenticated;
grant execute on function public.mark_mesh_erased(uuid) to service_role;

-- SECURITY DEFINER because it reads auth.users and auth.sessions, which the
-- service_role API role is not guaranteed to reach directly.
create function public.queue_abandoned_guests(p_idle_days integer default 90, p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz;
  v_uid uuid;
  v_n integer := 0;
begin
  -- Floor guards an operator typo from sweeping active guests.
  if p_idle_days is null or p_idle_days < 30 then
    raise exception 'p_idle_days must be at least 30' using errcode = 'invalid_parameter_value';
  end if;
  v_cutoff := now() - make_interval(days => p_idle_days);

  for v_uid in
    select u.id
    from auth.users u
    where u.is_anonymous
      and u.created_at < v_cutoff
      and not exists (select 1 from public.orders o where o.user_id = u.id)
      -- refreshed_at is timestamp without time zone (UTC) in hosted Supabase.
      and not exists (
        select 1 from auth.sessions se
        where se.user_id = u.id
          and coalesce(se.refreshed_at at time zone 'UTC', se.updated_at, se.created_at) > v_cutoff)
      and not exists (select 1 from public.account_deletion_requests r where r.user_id = u.id)
    order by u.created_at
    limit p_limit
  loop
    perform public.stamp_stray_scans_deleted(v_uid);
    insert into public.account_deletion_requests (user_id, reason)
    values (v_uid, 'abandoned_guest')
    on conflict (user_id) do nothing;
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

comment on function public.queue_abandoned_guests(integer, integer) is
  'Queue anonymous users idle for p_idle_days (min 30) with no orders for deletion and delete their scans. Returns the count queued. Service role only.';

revoke execute on function public.queue_abandoned_guests(integer, integer) from public, anon, authenticated;
grant execute on function public.queue_abandoned_guests(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- F. export_my_data: access request (GDPR art. 15). Everything still stored,
-- deleted-but-unpurged scans included. No storage paths.
-- ---------------------------------------------------------------------------
create function public.export_my_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'exported_at', now(),
    'account', (
      select jsonb_build_object('user_id', u.id, 'email', u.email,
        'is_anonymous', u.is_anonymous, 'created_at', u.created_at)
      from auth.users u where u.id = v_uid),
    'profile', (select to_jsonb(p) from public.profiles p where p.user_id = v_uid),
    'scans', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'leg', s.leg, 'status', s.status,
        'pair_id', s.pair_id, 'created_at', s.created_at, 'deleted_at', s.deleted_at,
        'mesh_deleted_at', s.mesh_deleted_at) order by s.created_at)
      from public.scans s where s.user_id = v_uid), '[]'::jsonb),
    'measurements', coalesce((
      select jsonb_agg(jsonb_build_object('scan_id', m.scan_id, 'schema_version', m.schema_version,
        'values', m."values", 'created_at', m.created_at) order by m.created_at)
      from public.measurements m join public.scans s on s.id = m.scan_id
      where s.user_id = v_uid), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'status', o.status,
        'amount_cents', o.amount_cents, 'address', o.address,
        'tracking_carrier', o.tracking_carrier, 'tracking_number', o.tracking_number,
        'created_at', o.created_at, 'product_name', p.name) order by o.created_at)
      from public.orders o join public.products p on p.id = o.product_id
      where o.user_id = v_uid), '[]'::jsonb)
  );
end;
$$;

comment on function public.export_my_data() is
  'Signed-in caller: their account, profile, scans, measurements and orders as one JSON document. No storage paths.';

revoke execute on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;

-- ---------------------------------------------------------------------------
-- G. 0011 redefinitions.
-- ---------------------------------------------------------------------------
-- Same as 0011 except `is distinct from`: user_id is nullable now, and an
-- ownerless row (account deleted) must be refused, not skipped by `<>`.
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

  perform public.fail_pipeline_job(pj.id, '{"reason": "scan_deleted"}'::jsonb, false)
    from public.pipeline_jobs pj
    where pj.scan_id = any(p_scan_ids) and pj.status = 'pending';
end;
$$;

revoke execute on function public.request_scan_deletion(uuid[]) from public, anon;
grant execute on function public.request_scan_deletion(uuid[]) to authenticated;

-- Return type changes (user_id -> storage_user_id), so drop + create.
drop function public.get_scans_pending_purge(integer);

create function public.get_scans_pending_purge(p_limit integer default 100)
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
      where o.scan_id_left = s.id or o.scan_id_right = s.id
    )
    and not exists (
      select 1 from public.pipeline_jobs pj
      where pj.scan_id = s.id and pj.status = 'running'
    )
  order by s.deleted_at
  limit p_limit;
$$;

comment on function public.get_scans_pending_purge(integer) is
  'Batch of owner-deleted scans to erase: not on any order, no running job. storage_user_id is the storage prefix. LIMIT-capped. Service role only.';

revoke execute on function public.get_scans_pending_purge(integer) from public, anon, authenticated;
grant execute on function public.get_scans_pending_purge(integer) to service_role;
