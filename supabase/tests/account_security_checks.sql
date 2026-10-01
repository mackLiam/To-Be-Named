-- Account security (supabase/migrations/0012_account_security.sql). Every
-- behavior is checked by writing as one role and observing as another (the
-- client role through RLS, the service role or superuser for the source of
-- truth), never by reading policy text. Run after stubs.sql and every
-- migration (run_sql_checks.sh).

\set ON_ERROR_STOP 1
\set QUIET 1

create schema sec;
grant usage on schema sec to anon, authenticated, service_role;

create function sec.eq(p_actual bigint, p_expected bigint, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'check failed: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

-- Runs p_sql and passes only if it fails with exactly p_state.
create function sec.fails(p_sql text, p_state text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then
      raise notice 'ok: %', p_label;
      return;
    end if;
    raise exception 'check failed: % (expected %, got % %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'check failed: % (statement succeeded)', p_label;
end;
$$;

-- Session claims as PostgREST sets them for the rest of the transaction.
-- A null uid is a request with no session.
create function sec.as_user(p_uid uuid, p_anonymous boolean) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  perform set_config('request.jwt.claims',
    case when p_uid is null then ''
    else jsonb_build_object('sub', p_uid, 'is_anonymous', p_anonymous)::text end, true);
end;
$$;

grant execute on all functions in schema sec to anon, authenticated, service_role;

\set product '12000000-9999-0000-0000-000000000001'

-- Users
\set guest '12000000-0000-0000-0000-000000000001'
\set member '12000000-0000-0000-0000-000000000002'
\set other '12000000-0000-0000-0000-000000000003'
\set tguest '12000000-0000-0000-0000-000000000011'
\set tmember '12000000-0000-0000-0000-000000000012'
\set xguest '12000000-0000-0000-0000-000000000013'
\set uguest '12000000-0000-0000-0000-000000000014'
\set del '12000000-0000-0000-0000-000000000021'
\set busy '12000000-0000-0000-0000-000000000022'
\set gone '12000000-0000-0000-0000-000000000023'
\set ag_old '12000000-0000-0000-0000-000000000031'
\set ag_member '12000000-0000-0000-0000-000000000032'
\set ag_order '12000000-0000-0000-0000-000000000033'
\set ag_fresh '12000000-0000-0000-0000-000000000034'
\set ag_new '12000000-0000-0000-0000-000000000035'
\set ag_upd '12000000-0000-0000-0000-000000000036'

-- Scans
\set g_l '12000000-1111-0000-0000-000000000001'
\set m_l '12000000-1111-0000-0000-000000000002'
\set m_r '12000000-1111-0000-0000-000000000003'
\set m_del '12000000-1111-0000-0000-000000000004'
\set o_l '12000000-1111-0000-0000-000000000005'
\set m_new '12000000-1111-0000-0000-000000000006'
\set t_up '12000000-1111-0000-0000-000000000011'
\set t_ready '12000000-1111-0000-0000-000000000012'
\set t_cap '12000000-1111-0000-0000-000000000013'
\set d_ord '12000000-1111-0000-0000-000000000021'
\set d_free '12000000-1111-0000-0000-000000000022'
\set d_pend '12000000-1111-0000-0000-000000000023'
\set b_ord '12000000-1111-0000-0000-000000000024'
\set gone_s '12000000-1111-0000-0000-000000000025'
\set ag_s '12000000-1111-0000-0000-000000000031'
\set ago_s '12000000-1111-0000-0000-000000000033'

-- Orders
\set t_order '12000000-2222-0000-0000-000000000011'
\set d_o1 '12000000-2222-0000-0000-000000000021'
\set d_o2 '12000000-2222-0000-0000-000000000022'

-- Fixtures (superuser, as the platform and the worker would write them).
insert into auth.users (id, is_anonymous, created_at) values
  (:'guest', true, now()), (:'member', false, now()), (:'other', false, now()),
  (:'tguest', true, now()), (:'tmember', false, now()), (:'xguest', true, now()), (:'uguest', true, now()),
  (:'del', false, now()), (:'busy', false, now()), (:'gone', false, now()),
  (:'ag_old', true, now() - interval '200 days'), (:'ag_member', false, now() - interval '200 days'),
  (:'ag_order', true, now() - interval '200 days'), (:'ag_fresh', true, now() - interval '200 days'),
  (:'ag_new', true, now()), (:'ag_upd', true, now() - interval '200 days');
insert into public.products (id, name, slug, base_price_cents, cad_model)
values (:'product', 'Guard', 'sec-guard', 8900, '{"provider":"dry_run"}');

insert into public.scans (id, user_id, leg, status, mesh_path) values
  (:'g_l', :'guest', 'L', 'uploaded', :'guest' || '/g.obj'),
  (:'m_l', :'member', 'L', 'uploaded', :'member' || '/l.obj'),
  (:'m_r', :'member', 'R', 'uploaded', :'member' || '/r.obj'),
  (:'m_del', :'member', 'L', 'uploaded', :'member' || '/d.obj'),
  (:'o_l', :'other', 'L', 'uploaded', :'other' || '/o.obj');
update public.scans set deleted_at = now() where id = :'m_del';

select sec.eq((select count(*) from public.scans where id = :'m_l' and storage_user_id = :'member'), 1,
  'storage_user_id is set from user_id on insert');

-- ---------------------------------------------------------------------------
-- 1. Orders: members only, as an unpaid shell on their own live scans.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select sec.as_user(:'guest', true);
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left) values (%L, %L, %L)',
  :'guest', :'product', :'g_l'), '42501', 'guest cannot insert an order');
-- A session without the is_anonymous claim is treated as a guest.
select set_config('request.jwt.claims', '{}', true);
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left) values (%L, %L, %L)',
  :'guest', :'product', :'g_l'), '42501', 'missing is_anonymous claim counts as a guest');
commit;

begin;
set local role authenticated;
select sec.as_user(:'member', false);
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left, status) values (%L, %L, %L, %L)',
  :'member', :'product', :'m_l', 'paid'), '42501', 'member cannot insert a paid order');
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left, amount_cents) values (%L, %L, %L, 0)',
  :'member', :'product', :'m_l'), '42501', 'member cannot set amount_cents');
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left, stripe_payment_intent) values (%L, %L, %L, %L)',
  :'member', :'product', :'m_l', 'pi_fake'), '42501', 'member cannot set a payment intent');
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left, tracking_carrier) values (%L, %L, %L, %L)',
  :'member', :'product', :'m_l', 'ups'), '42501', 'member cannot set tracking_carrier');
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left, tracking_number) values (%L, %L, %L, %L)',
  :'member', :'product', :'m_l', '1Z'), '42501', 'member cannot set tracking_number');
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left) values (%L, %L, %L)',
  :'member', :'product', :'o_l'), '42501', 'member cannot order on another user''s scan');
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left) values (%L, %L, %L)',
  :'member', :'product', :'m_r'), '42501', 'member cannot put a right-leg scan in the left slot');
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_right) values (%L, %L, %L)',
  :'member', :'product', :'m_l'), '42501', 'member cannot put a left-leg scan in the right slot');
-- 0011's trigger refuses a deleted scan before RLS is evaluated.
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left) values (%L, %L, %L)',
  :'member', :'product', :'m_del'), '23514', 'member cannot order on a deleted scan');
insert into public.orders (user_id, product_id, scan_id_left, scan_id_right)
values (:'member', :'product', :'m_l', :'m_r');
commit;

-- The policy refuses a deleted scan on its own too (0011 trigger off).
begin;
alter table public.orders disable trigger orders_reject_deleted_scans;
set local role authenticated;
select sec.as_user(:'member', false);
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left) values (%L, %L, %L)',
  :'member', :'product', :'m_del'), '42501', 'orders policy alone refuses a deleted scan');
rollback;

select sec.eq((select count(*) from public.orders where user_id = :'member' and status = 'pending_payment'
  and amount_cents is null and stripe_payment_intent is null), 1,
  'member pending_payment order is stored (and nothing else was)');
select sec.eq((select count(*) from public.orders where user_id = :'guest'), 0, 'no guest order was stored');

begin;
set local role authenticated;
select sec.as_user(:'other', false);
select sec.eq((select count(*) from public.orders), 0, 'another member cannot see the order');
commit;

-- ---------------------------------------------------------------------------
-- 2. Scans: no client delete, pinned storage owner, frozen deleted_at,
-- mesh_path inside the storage prefix.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select sec.as_user(:'member', false);
delete from public.scans where id = :'m_l';
update public.scans set storage_user_id = :'other' where id = :'m_r';
update public.scans set deleted_at = null where id = :'m_del';
insert into public.scans (id, user_id, storage_user_id, leg) values (:'m_new', :'member', :'other', 'L');
select sec.fails(format('update public.scans set mesh_path = %L where id = %L', :'other' || '/x.obj', :'m_r'),
  '42501', 'client cannot point mesh_path at another storage prefix');
select sec.fails(format('insert into public.scans (user_id, leg, mesh_path) values (%L, %L, %L)', :'member', 'R', :'other' || '/x.obj'),
  '42501', 'client cannot insert a scan with mesh_path outside its prefix');
select sec.fails(format('update public.scans set mesh_path = %L where id = %L', :'other', :'m_r'),
  '42501', 'mesh_path equal to another bare prefix is refused');
commit;

select sec.eq((select count(*) from public.scans where id = :'m_l'), 1, 'client cannot delete a scans row');
select sec.eq((select count(*) from public.scans where id = :'m_r' and storage_user_id = :'member'), 1,
  'client cannot change storage_user_id');
select sec.eq((select count(*) from public.scans where id = :'m_new' and storage_user_id = :'member'), 1,
  'client-supplied storage_user_id on insert is ignored');
select sec.eq((select count(*) from public.scans where id = :'m_del' and deleted_at is not null), 1,
  'client cannot clear deleted_at');
select sec.eq((select count(*) from public.scans where id = :'m_r' and mesh_path = :'member' || '/r.obj'), 1,
  'refused mesh_path update left the row unchanged');

-- ---------------------------------------------------------------------------
-- 3. Guest to member transfer.
-- ---------------------------------------------------------------------------
insert into public.scans (id, user_id, leg, status, mesh_path) values
  (:'t_up', :'tguest', 'L', 'uploaded', :'tguest' || '/up.obj'),
  (:'t_ready', :'tguest', 'R', 'ready', :'tguest' || '/ready.obj'),
  (:'t_cap', :'tguest', 'L', 'capturing', null);
-- A pre-0012 guest order (guests can no longer create one).
insert into public.orders (id, user_id, product_id, scan_id_left)
values (:'t_order', :'tguest', :'product', :'t_up');

begin;
set local role authenticated;
select sec.as_user(:'tmember', false);
select sec.fails('select public.begin_guest_transfer()', '42501', 'begin_guest_transfer refused for a member');
-- Anonymous JWT but the stored user is a member (upgraded, token not refreshed).
select sec.as_user(:'tmember', true);
select sec.fails('select public.begin_guest_transfer()', '42501', 'begin_guest_transfer refused for an upgraded user with a stale JWT');
select sec.as_user(null, null);
select sec.fails('select public.begin_guest_transfer()', '42501', 'begin_guest_transfer refused without a session');
commit;

begin;
set local role anon;
select sec.fails('select public.begin_guest_transfer()', '42501', 'begin_guest_transfer refused for anon');
select sec.fails('select public.claim_guest_transfer(''x'')', '42501', 'claim_guest_transfer refused for anon');
commit;

begin;
set local role authenticated;
select sec.as_user(:'tguest', true);
select public.begin_guest_transfer() as stale_token \gset
select public.begin_guest_transfer() as token \gset
select sec.fails(format('select public.claim_guest_transfer(%L)', :'token'), '42501', 'claim refused for a guest caller');
select sec.as_user(:'xguest', true);
select public.begin_guest_transfer() as xtoken \gset
select sec.as_user(:'uguest', true);
select public.begin_guest_transfer() as utoken \gset
commit;

select sec.eq((select count(*) from public.guest_transfers where guest_user_id = :'tguest'), 1,
  'a new token replaces the caller''s earlier one');
select sec.eq((select count(*) from public.guest_transfers where token_hash = convert_to(:'token', 'UTF8')), 0,
  'token is stored hashed, not in clear');
update public.guest_transfers set expires_at = now() - interval '1 minute' where guest_user_id = :'xguest';
update auth.users set is_anonymous = false where id = :'uguest';

begin;
set local role authenticated;
select sec.as_user(:'tmember', false);
select sec.fails(format('select public.claim_guest_transfer(%L)', :'stale_token'), '22023', 'claim refused for a replaced token');
select sec.fails('select public.claim_guest_transfer(''not-a-token'')', '22023', 'claim refused for an unknown token');
select sec.fails('select public.claim_guest_transfer(null)', '22023', 'claim refused for a null token');
select sec.fails(format('select public.claim_guest_transfer(%L)', :'xtoken'), '22023', 'claim refused for an expired token');
select sec.fails(format('select public.claim_guest_transfer(%L)', :'utoken'), '22023', 'claim refused when the guest was upgraded');
select sec.as_user(:'tmember', true);
select sec.fails(format('select public.claim_guest_transfer(%L)', :'token'), '42501', 'claim refused for a member session marked anonymous');
select sec.as_user(:'tmember', false);
select sec.eq(public.claim_guest_transfer(:'token'), 2, 'claim moves the uploaded and ready scans');
select sec.fails(format('select public.claim_guest_transfer(%L)', :'token'), '22023', 'claim refused for a reused token');
select sec.eq((select count(*) from public.scans), 2, 'member sees the moved scans');
select sec.eq((select count(*) from public.orders where id = :'t_order'), 1, 'member sees the moved order');
-- Moved rows keep the guest prefix, which still satisfies the mesh_path check.
with u as (update public.scans set capture_meta = '{"k":1}' where id = :'t_up' returning 1)
select sec.eq((select count(*) from u), 1, 'member can update a moved scan under the guest prefix');
commit;

begin;
set local role authenticated;
select sec.as_user(:'tguest', true);
-- "scans: select own" does not filter deleted_at; the app hides those rows.
select sec.eq((select count(*) from public.scans where deleted_at is null), 0, 'guest sees no live scans after the claim');
select sec.eq((select count(*) from public.scans where id = :'t_cap'), 1, 'guest still owns only its deleted capture');
select sec.eq((select count(*) from public.orders), 0, 'guest sees no orders after the claim');
commit;

select sec.eq((select count(*) from public.scans where id in (:'t_up', :'t_ready')
  and user_id = :'tmember' and storage_user_id = :'tguest'), 2, 'moved scans keep storage_user_id = guest');
select sec.eq((select count(*) from public.scans where id = :'t_cap'
  and user_id = :'tguest' and deleted_at is not null), 1, 'capturing scan stays with the guest and is stamped deleted');
select sec.eq((select count(*) from public.account_deletion_requests
  where user_id = :'tguest' and reason = 'merged_guest'), 1, 'merged guest is queued for deletion');

-- ---------------------------------------------------------------------------
-- 4. request_account_deletion
-- ---------------------------------------------------------------------------
insert into public.scans (id, user_id, leg, status, mesh_path) values
  (:'d_ord', :'del', 'L', 'ready', :'del' || '/ord.obj'),
  (:'d_free', :'del', 'R', 'uploaded', :'del' || '/free.obj'),
  (:'d_pend', :'del', 'L', 'ready', :'del' || '/pend.obj');
insert into public.measurements (scan_id, schema_version, extraction_version, "values")
values (:'d_ord', '1.0.0', 'test', '{}');
insert into public.pipeline_jobs (scan_id, step, status) values (:'d_free', 'measuring', 'pending');
insert into public.orders (id, user_id, product_id, scan_id_left, status) values
  (:'d_o1', :'del', :'product', :'d_ord', 'in_production'),
  (:'d_o2', :'del', :'product', :'d_pend', 'pending_payment');

begin;
set local role authenticated;
select sec.as_user(:'del', false);
select sec.fails('select public.request_account_deletion()', '23514', 'deletion refused with an order in_production');
commit;
update public.orders set status = 'shipped' where id = :'d_o1';
begin;
set local role authenticated;
select sec.as_user(:'del', false);
select sec.fails('select public.request_account_deletion()', '23514', 'deletion refused with a shipped order');
commit;
-- Fires orders_enqueue_cad (0008), hence the measurement and cad_model above.
update public.orders set status = 'paid' where id = :'d_o1';
begin;
set local role authenticated;
select sec.as_user(:'del', false);
select sec.fails('select public.request_account_deletion()', '23514', 'deletion refused with a paid order');
commit;
update public.pipeline_jobs set status = 'succeeded' where order_id = :'d_o1';
update public.orders set status = 'delivered' where id = :'d_o1';

select sec.eq((select count(*) from public.account_deletion_requests where user_id = :'del'), 0,
  'refused requests recorded nothing');
select sec.eq((select count(*) from public.orders where id = :'d_o2' and status = 'pending_payment'), 1,
  'refused requests cancelled nothing');

begin;
set local role authenticated;
select sec.as_user(null, null);
select sec.fails('select public.request_account_deletion()', '42501', 'deletion refused without a session');
select sec.as_user(:'del', false);
select public.request_account_deletion();
select public.request_account_deletion();
commit;

begin;
set local role anon;
select sec.fails('select public.request_account_deletion()', '42501', 'request_account_deletion refused for anon');
commit;

select sec.eq((select count(*) from public.orders where id = :'d_o2' and status = 'cancelled'), 1,
  'pending_payment order is cancelled');
select sec.eq((select count(*) from public.orders where id = :'d_o1' and status = 'delivered'), 1,
  'delivered order is untouched');
select sec.eq((select count(*) from public.scans where id = :'d_free' and deleted_at is not null), 1,
  'unordered scan is stamped deleted');
select sec.eq((select count(*) from public.scans where id in (:'d_ord', :'d_pend') and deleted_at is null), 2,
  'ordered scans are kept');
select sec.eq((select count(*) from public.pipeline_jobs where scan_id = :'d_free' and status = 'dead_letter'
  and error ->> 'reason' = 'account_deleted'), 1, 'pending job of the stamped scan is dead-lettered');
select sec.eq((select count(*) from public.account_deletion_requests where user_id = :'del' and reason = 'user_request'), 1,
  'request recorded once across two calls');

begin;
set local role authenticated;
select sec.as_user(:'del', false);
select sec.fails(format('insert into public.orders (user_id, product_id, scan_id_left) values (%L, %L, %L)',
  :'del', :'product', :'d_pend'), '42501', 'no new order once account deletion is requested');
rollback;

-- ---------------------------------------------------------------------------
-- 5. Worker side: pending accounts, mesh erase, auth user deletion.
-- ---------------------------------------------------------------------------
insert into public.scans (id, user_id, leg, status) values (:'b_ord', :'busy', 'L', 'ready');
insert into public.orders (user_id, product_id, scan_id_left, status) values (:'busy', :'product', :'b_ord', 'shipped');
insert into public.account_deletion_requests (user_id, reason) values (:'busy', 'user_request');

begin;
set local role service_role;
select sec.eq((select count(*) from public.get_accounts_pending_deletion() where user_id = :'del'), 0,
  'account with an unpurged deleted scan is not ready');
select sec.eq((select count(*) from public.get_accounts_pending_deletion() where user_id = :'busy'), 0,
  'account with an active order is not ready');
select sec.eq((select count(*) from public.get_accounts_pending_deletion() where user_id = :'tguest'), 0,
  'merged guest waits for its deleted capture to be purged');
select sec.eq((select count(*) from public.get_scans_pending_purge(100)
  where scan_id = :'t_cap' and storage_user_id = :'tguest'), 1, 'purge batch returns storage_user_id');
-- The purge worker (0011) erases the deleted scan.
delete from public.scans where id = :'d_free';
-- A client stamped an ordered scan deleted directly ("scans: update own"):
-- the purge never takes it, so it must not hold the account back.
update public.scans set deleted_at = now() where id = :'d_pend';
select sec.eq((select count(*) from public.get_accounts_pending_deletion() where user_id = :'del' and reason = 'user_request'), 1,
  'account is ready once its deleted scans are purged');
select sec.eq((select count(*) from public.get_account_meshes_to_erase(:'del')), 2,
  'kept ordered scans are listed for mesh erase');
select sec.eq((select count(*) from public.get_account_meshes_to_erase(:'del')
  where storage_user_id = :'del' and mesh_path = :'del' || '/ord.obj'), 1, 'mesh erase rows carry the storage prefix owner');
select public.mark_mesh_erased(:'d_ord');
select public.mark_mesh_erased(:'d_ord');
select sec.eq((select count(*) from public.get_account_meshes_to_erase(:'del')), 1,
  'mark_mesh_erased removes the scan from the erase list (idempotent)');
select sec.eq(public.stamp_stray_scans_deleted(:'del'), 0, 'no stray unordered scans left to stamp');
commit;

-- The worker deletes the auth user via the Admin API.
delete from auth.users where id = :'del';
select sec.eq((select count(*) from public.orders where id in (:'d_o1', :'d_o2') and user_id is null), 2,
  'orders survive the auth user with user_id null');
select sec.eq((select count(*) from public.scans where id in (:'d_ord', :'d_pend')
  and user_id is null and storage_user_id = :'del'), 2, 'ordered scans survive with user_id null and storage_user_id intact');
select sec.eq((select count(*) from public.measurements where scan_id = :'d_ord'), 1, 'measurements of a kept scan survive');
select sec.eq((select count(*) from public.account_deletion_requests where user_id = :'del'), 0,
  'the request goes with the auth user');

-- An ownerless scan cannot be deleted by anyone through the RPC (0011 used <>).
insert into public.scans (id, user_id, leg, status) values (:'gone_s', :'gone', 'L', 'ready');
delete from auth.users where id = :'gone';
begin;
set local role authenticated;
select sec.as_user(:'member', false);
select sec.fails(format('select public.request_scan_deletion(array[%L]::uuid[])', :'gone_s'),
  '42501', 'request_scan_deletion refuses an ownerless scan');
commit;

-- ---------------------------------------------------------------------------
-- 6. queue_abandoned_guests
-- ---------------------------------------------------------------------------
insert into public.scans (id, user_id, leg, status) values
  (:'ag_s', :'ag_old', 'L', 'uploaded'),
  (:'ago_s', :'ag_order', 'L', 'ready');
insert into public.pipeline_jobs (scan_id, step, status) values (:'ag_s', 'measuring', 'pending');
insert into public.orders (user_id, product_id, scan_id_left) values (:'ag_order', :'product', :'ago_s');
insert into auth.sessions (user_id, created_at, updated_at, refreshed_at) values
  (:'ag_old', now() - interval '150 days', now() - interval '150 days', (now() - interval '100 days') at time zone 'UTC'),
  (:'ag_fresh', now() - interval '150 days', now() - interval '150 days', (now() - interval '1 day') at time zone 'UTC'),
  (:'ag_upd', now() - interval '150 days', now() - interval '2 days', null);

begin;
set local role service_role;
select sec.fails('select public.queue_abandoned_guests(29)', '22023', 'idle days below 30 is refused');
select sec.fails('select public.queue_abandoned_guests(null)', '22023', 'null idle days is refused');
select sec.eq(public.queue_abandoned_guests(), 1, 'exactly one abandoned guest is queued');
select sec.eq(public.queue_abandoned_guests(), 0, 'a second sweep queues nothing');
commit;

select sec.eq((select count(*) from public.account_deletion_requests where user_id = :'ag_old' and reason = 'abandoned_guest'), 1,
  'old idle guest with no orders is queued');
select sec.eq((select count(*) from public.account_deletion_requests
  where user_id in (:'ag_member', :'ag_order', :'ag_fresh', :'ag_new', :'ag_upd')), 0,
  'member, guest with an order, refreshed guest, recently updated session and new guest are skipped');
select sec.eq((select count(*) from public.scans where id = :'ag_s' and deleted_at is not null), 1,
  'abandoned guest scans are stamped deleted');
select sec.eq((select count(*) from public.pipeline_jobs where scan_id = :'ag_s' and status = 'dead_letter'), 1,
  'abandoned guest pending jobs are dead-lettered');
select sec.eq((select count(*) from public.scans where id = :'ago_s' and deleted_at is null), 1,
  'skipped guest scans are untouched');

-- ---------------------------------------------------------------------------
-- 7. export_my_data: write as one user, export as another.
-- ---------------------------------------------------------------------------
insert into public.measurements (scan_id, schema_version, extraction_version, "values")
values (:'o_l', '1.0.0', 'test', '{"Leg_Length": 400}'), (:'m_l', '1.0.0', 'test', '{"Leg_Length": 410}');

begin;
set local role authenticated;
select sec.as_user(:'other', false);
insert into public.profiles (user_id, name) values (:'other', 'Other Person');
select public.export_my_data()::text as other_export \gset
select sec.as_user(:'member', false);
insert into public.profiles (user_id, name) values (:'member', 'Member Person');
select public.export_my_data() as member_export \gset
select sec.eq(jsonb_array_length(:'member_export'::jsonb -> 'scans'), (select count(*) from public.scans),
  'export holds every scan the member can see');
select sec.eq(jsonb_array_length(:'member_export'::jsonb -> 'orders'), (select count(*) from public.orders),
  'export holds every order the member can see');
select sec.eq(jsonb_array_length(:'member_export'::jsonb -> 'measurements'), 1, 'export holds the member measurement');
commit;

select sec.eq((position(:'o_l' in :'member_export') + position('Other Person' in :'member_export')
  + position('"Leg_Length": 400' in :'member_export'))::bigint, 0, 'member export contains none of the other user''s rows');
select sec.eq((:'member_export'::jsonb #>> '{account,user_id}' = :'member')::int, 1, 'export account is the caller');
select sec.eq((:'member_export'::jsonb #>> '{profile,name}' = 'Member Person')::int, 1, 'export profile is the caller''s');
select sec.eq((position(:'o_l' in :'other_export') > 0 and position(:'m_l' in :'other_export') = 0)::int, 1,
  'other export holds its own scan and not the member''s');
select sec.eq((position('.obj' in :'member_export'))::bigint, 0, 'export contains no storage paths');

begin;
set local role authenticated;
select sec.as_user(null, null);
select sec.fails('select public.export_my_data()', '42501', 'export refused without a session');
commit;
begin;
set local role anon;
select sec.fails('select public.export_my_data()', '42501', 'export refused for anon');
commit;

-- ---------------------------------------------------------------------------
-- 8. Service-only surface is denied to clients.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select sec.as_user(:'member', false);
select sec.fails('select * from public.get_accounts_pending_deletion()', '42501', 'authenticated: get_accounts_pending_deletion denied');
select sec.fails(format('select * from public.get_account_meshes_to_erase(%L)', :'member'), '42501', 'authenticated: get_account_meshes_to_erase denied');
select sec.fails(format('select public.mark_mesh_erased(%L)', :'m_l'), '42501', 'authenticated: mark_mesh_erased denied');
select sec.fails(format('select public.stamp_stray_scans_deleted(%L)', :'member'), '42501', 'authenticated: stamp_stray_scans_deleted denied');
select sec.fails('select public.queue_abandoned_guests()', '42501', 'authenticated: queue_abandoned_guests denied');
select sec.fails('select * from public.get_scans_pending_purge()', '42501', 'authenticated: get_scans_pending_purge denied');
select sec.fails('select * from public.guest_transfers', '42501', 'authenticated: guest_transfers table denied');
select sec.fails('select * from public.account_deletion_requests', '42501', 'authenticated: account_deletion_requests table denied');
commit;

begin;
set local role anon;
select sec.fails('select * from public.get_accounts_pending_deletion()', '42501', 'anon: get_accounts_pending_deletion denied');
select sec.fails(format('select * from public.get_account_meshes_to_erase(%L)', :'member'), '42501', 'anon: get_account_meshes_to_erase denied');
select sec.fails(format('select public.mark_mesh_erased(%L)', :'m_l'), '42501', 'anon: mark_mesh_erased denied');
select sec.fails(format('select public.stamp_stray_scans_deleted(%L)', :'member'), '42501', 'anon: stamp_stray_scans_deleted denied');
select sec.fails('select public.queue_abandoned_guests()', '42501', 'anon: queue_abandoned_guests denied');
select sec.fails('select * from public.get_scans_pending_purge()', '42501', 'anon: get_scans_pending_purge denied');
select sec.fails('select * from public.guest_transfers', '42501', 'anon: guest_transfers table denied');
select sec.fails('select * from public.account_deletion_requests', '42501', 'anon: account_deletion_requests table denied');
commit;

select sec.eq((select count(*) from public.scans where id = :'m_l' and mesh_deleted_at is null), 1,
  'denied mark_mesh_erased changed nothing');

-- ---------------------------------------------------------------------------
-- Cleanup. The check files share one database and later files count rows
-- globally (scans deleted, CAD jobs), so remove every row this file wrote.
-- ---------------------------------------------------------------------------
delete from public.orders where product_id = :'product';
delete from public.scans where id::text like '12000000-1111-%';
delete from auth.users where id::text like '12000000-0000-%';
delete from public.products where id = :'product';
select sec.eq((select count(*) from public.account_deletion_requests r
  where r.user_id::text like '12000000-%'), 0, 'cleanup left no rows behind');
