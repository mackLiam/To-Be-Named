-- Behavioral checks for 0015_retention_and_dead_orders.sql: dead (cancelled,
-- never paid) orders no longer pin scans, purge_scan_row, paid_at on every
-- path to paid, and the widened retention batch. Fixtures are written as the
-- superuser; roles are switched for the client and service-role calls.
-- Every fixture is deleted at the end: later files count rows globally.
-- Run by run_sql_checks.sh.

\set ON_ERROR_STOP 1
\set QUIET 1

create schema checks15;

-- Backdate orders past the 24-hour dead-order hold. set_updated_at would
-- stamp now() again, so it is paused for the backdate.
create function checks15.age_orders(p_ids uuid[]) returns void
language plpgsql as $$
begin
  alter table public.orders disable trigger set_updated_at;
  update public.orders set updated_at = now() - interval '2 days' where id = any(p_ids);
  alter table public.orders enable trigger set_updated_at;
end;
$$;
grant usage on schema checks15 to anon, authenticated, service_role;

create function checks15.expect_error(p_sql text, p_state text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected SQLSTATE % but succeeded: %', p_state, p_sql;
exception when others then
  if sqlstate <> p_state then
    raise exception 'expected SQLSTATE %, got % (%): %', p_state, sqlstate, sqlerrm, p_sql;
  end if;
end;
$$;

create function checks15.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'check failed: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

-- Row counts that a refused purge must leave exactly as they were.
create function checks15.snapshot() returns text
language sql as $$
  select (select count(*) from public.scans where id::text like '15000000-%') || '/'
      || (select count(*) from public.orders where id::text like '15000000-%') || '/'
      || (select count(*) from public.measurements where scan_id::text like '15000000-%') || '/'
      || (select count(*) from public.audit_log where actor = 'checks15');
$$;

grant execute on all functions in schema checks15 to anon, authenticated, service_role;

\set ua '15000000-0000-0000-0000-00000000000a'
\set ub '15000000-0000-0000-0000-00000000000b'
\set uc '15000000-0000-0000-0000-00000000000c'
\set ud '15000000-0000-0000-0000-00000000000d'
\set prod '15000000-1111-0000-0000-000000000001'
\set s_aband '15000000-2222-0000-0000-000000000001'
\set s_paidc '15000000-2222-0000-0000-000000000002'
\set s_live '15000000-2222-0000-0000-000000000003'
\set s_b1 '15000000-2222-0000-0000-000000000004'
\set s_b2 '15000000-2222-0000-0000-000000000005'
\set s_c1 '15000000-2222-0000-0000-000000000006'
\set s_c2 '15000000-2222-0000-0000-000000000007'
\set s_d1 '15000000-2222-0000-0000-000000000008'
\set o_aband '15000000-3333-0000-0000-000000000001'
\set o_paidc '15000000-3333-0000-0000-000000000002'
\set o_live '15000000-3333-0000-0000-000000000003'
\set o_b1 '15000000-3333-0000-0000-000000000004'
\set o_b2 '15000000-3333-0000-0000-000000000005'
\set o_c1 '15000000-3333-0000-0000-000000000006'
\set o_man '15000000-3333-0000-0000-000000000007'
\set o_hook '15000000-3333-0000-0000-000000000008'
\set o_d1 '15000000-3333-0000-0000-000000000009'

insert into auth.users (id) values (:'ua'), (:'ub'), (:'uc'), (:'ud');
-- cad_model and measurements: marking an order paid enqueues CAD (0008).
insert into public.products (id, name, slug, base_price_cents, cad_model) values
  (:'prod', 'Guard15', 'guard-15', 8900, '{"provider":"dry_run"}');
insert into public.scans (id, user_id, leg, status) values
  (:'s_aband', :'ua', 'L', 'ready'),
  (:'s_paidc', :'ua', 'L', 'ready'),
  (:'s_live', :'ua', 'L', 'ready'),
  (:'s_b1', :'ub', 'L', 'ready'),
  (:'s_b2', :'ub', 'R', 'ready'),
  (:'s_c1', :'uc', 'L', 'ready'),
  (:'s_c2', :'uc', 'R', 'ready'),
  (:'s_d1', :'ud', 'L', 'ready');
insert into public.measurements (scan_id, schema_version, extraction_version, "values") values
  (:'s_aband', '1.0.0', 'test', '{}'), (:'s_paidc', '1.0.0', 'test', '{}'),
  (:'s_live', '1.0.0', 'test', '{}'), (:'s_b2', '1.0.0', 'test', '{}');
-- o_aband: abandoned checkout (0013 expiry: pending_payment -> cancelled).
-- o_paidc: paid, then cancelled (paid_at kept: money to refund).
insert into public.orders (id, user_id, product_id, scan_id_left, status) values
  (:'o_aband', :'ua', :'prod', :'s_aband', 'pending_payment'),
  (:'o_live', :'ua', :'prod', :'s_live', 'pending_payment'),
  (:'o_paidc', :'ua', :'prod', :'s_paidc', 'pending_payment'),
  (:'o_b1', :'ub', :'prod', :'s_b1', 'pending_payment'),
  (:'o_b2', :'ub', :'prod', :'s_b2', 'pending_payment'),
  (:'o_c1', :'uc', :'prod', :'s_c1', 'pending_payment');
update public.orders set status = 'cancelled' where id in (:'o_aband', :'o_c1');
update public.orders set status = 'paid' where id in (:'o_paidc', :'o_b2');
update public.orders set status = 'cancelled' where id in (:'o_paidc', :'o_b2');
insert into public.pipeline_jobs (scan_id, step, status) values (:'s_c1', 'measuring', 'pending');

-- ---------------------------------------------------------------------------
-- Privileges: the new service-role functions are not client-callable.
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select checks15.expect_error(format('select public.purge_scan_row(%L, %L)', :'s_aband', 'x'), '42501');
select checks15.expect_error('select public.order_is_live(''cancelled'', null)', '42501');
select checks15.expect_error('select * from public.get_meshes_pending_deletion()', '42501');
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select checks15.expect_error(format('select public.purge_scan_row(%L, %L)', :'s_aband', 'x'), '42501');
select checks15.expect_error('select public.order_is_live(''cancelled'', null)', '42501');
select checks15.expect_error('select * from public.get_meshes_pending_deletion()', '42501');
reset role;
select checks15.eq(
  (select bool_or(has_function_privilege(r, 'public.orders_stamp_paid_at()', 'execute'))
     from unnest(array['anon', 'authenticated']) r),
  false, 'anon/authenticated cannot execute the paid_at trigger function');

-- ---------------------------------------------------------------------------
-- paid_at: the manual mark-paid path sets it; an existing value is kept.
-- ---------------------------------------------------------------------------
select checks15.eq((select paid_at is not null from public.orders where id = :'o_paidc'), true,
  'manual mark-paid sets paid_at');
select checks15.eq((select paid_at is null from public.orders where id = :'o_aband'), true,
  'an order never paid keeps paid_at null');
insert into public.orders (id, user_id, product_id, scan_id_left, status, paid_at) values
  (:'o_man', :'ua', :'prod', :'s_live', 'paid', null),
  (:'o_hook', :'ua', :'prod', :'s_live', 'pending_payment', '2026-01-01T00:00:00Z');
select checks15.eq((select paid_at is not null from public.orders where id = :'o_man'), true,
  'an order inserted as paid gets paid_at');
update public.orders set status = 'paid' where id = :'o_hook';
update public.orders set status = 'in_production' where id = :'o_hook';
select checks15.eq((select paid_at from public.orders where id = :'o_hook'), '2026-01-01T00:00:00Z'::timestamptz,
  'a webhook-set paid_at is never overwritten');
-- Their CAD jobs go first: 0016's index would collide on the set-null.
delete from public.pipeline_jobs where order_id in (:'o_man', :'o_hook');
delete from public.orders where id in (:'o_man', :'o_hook');

-- ---------------------------------------------------------------------------
-- request_scan_deletion: only a live order refuses.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'ua', true);
select public.request_scan_deletion(array[:'s_aband']::uuid[]);
select checks15.expect_error(format('select public.request_scan_deletion(array[%L]::uuid[])', :'s_paidc'), '23514');
select checks15.expect_error(format('select public.request_scan_deletion(array[%L]::uuid[])', :'s_live'), '23514');
commit;
select checks15.eq((select deleted_at is not null from public.scans where id = :'s_aband'), true,
  'abandoned-checkout scan can be deleted by its owner');
select checks15.eq((select deleted_at is null from public.scans where id = :'s_paidc'), true,
  'scan on a paid-then-cancelled order is still refused');
select checks15.eq((select deleted_at is null from public.scans where id = :'s_live'), true,
  'scan on a live pending order is still refused');

-- ---------------------------------------------------------------------------
-- get_scans_pending_purge + purge_scan_row.
-- s_paidc is stamped directly (as "scans: update own" allows, 0011) to show
-- a live order still protects it.
-- ---------------------------------------------------------------------------
update public.scans set deleted_at = now() where id = :'s_paidc';

-- A dead order cancelled within 24 hours may still have a payable Stripe
-- session, so it holds its scan until it ages out.
set role service_role;
select checks15.eq(
  (select count(*) from public.get_scans_pending_purge(100000) where scan_id = :'s_aband')::int, 0,
  'a freshly cancelled dead order still holds its scan from the purge batch');
select checks15.eq(public.purge_scan_row(:'s_aband', 'checks15'), false,
  'purge_scan_row waits out a freshly cancelled dead order');
reset role;
select checks15.age_orders(array[:'o_aband', :'o_c1', :'o_paidc', :'o_b2']::uuid[]);

set role service_role;
select checks15.eq(
  (select string_agg(scan_id::text, ',' order by scan_id) from public.get_scans_pending_purge(100000)
    where scan_id::text like '15000000-%'),
  :'s_aband', 'purge batch holds the dead-order scan, not the live-order one');

select checks15.eq(public.purge_scan_row(:'s_aband', 'checks15'), true, 'purge_scan_row purges the dead-order scan');
reset role;
select checks15.eq((select count(*) from public.scans where id = :'s_aband')::int, 0, 'purged scan row is gone');
select checks15.eq((select count(*) from public.orders where id = :'o_aband')::int, 0, 'its dead order is gone');
select checks15.eq((select count(*) from public.measurements where scan_id = :'s_aband')::int, 0,
  'its measurements cascade');
select checks15.eq(
  (select string_agg(action || ':' || subject_table || ':' || subject_id, ',' order by id)
     from public.audit_log where actor = 'checks15'),
  'order_purged_with_scan:orders:' || :'o_aband' || ',scan_purged:scans:' || :'s_aband',
  'purge audits the dead order and the scan');

select checks15.snapshot() as before_refusals \gset
set role service_role;
select checks15.eq(public.purge_scan_row(:'s_aband', 'checks15'), false, 'second purge of the same scan is false');
select checks15.eq(public.purge_scan_row(:'s_paidc', 'checks15'), false, 'purge refuses a scan on a paid-then-cancelled order');
select checks15.eq(public.purge_scan_row(:'s_live', 'checks15'), false, 'purge refuses a scan that is not deleted');
reset role;
select checks15.eq(checks15.snapshot(), :'before_refusals', 'refused purges changed nothing');
select checks15.eq((select count(*) from public.orders where id = :'o_paidc')::int, 1, 'the paid order record is kept');

-- ---------------------------------------------------------------------------
-- Account deletion: unpaid orders are cancelled (dead), so their scans are
-- stamped and purged before the account is ready. A deleted scan on a live
-- order is kept and does not hold the account back.
-- ---------------------------------------------------------------------------
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'ub', true);
select public.request_account_deletion();
commit;
select checks15.eq((select deleted_at is not null from public.scans where id = :'s_b1'), true,
  'account deletion stamps a scan whose only order it just cancelled');
select checks15.eq((select deleted_at is null from public.scans where id = :'s_b2'), true,
  'account deletion keeps a scan on a paid-then-cancelled order');
update public.scans set deleted_at = now() where id = :'s_b2';

-- Ids first: ALTER TABLE cannot run while a query on orders is still open.
select array_agg(id) as ub_orders from public.orders where user_id = :'ub' \gset
select checks15.age_orders(:'ub_orders'::uuid[]);

set role service_role;
select checks15.eq((select count(*) from public.get_accounts_pending_deletion(100000) where user_id = :'ub')::int, 0,
  'account waits while a dead-order scan is unpurged');
select checks15.eq(public.purge_scan_row(:'s_b1', 'checks15'), true, 'the account''s dead-order scan purges');
select checks15.eq((select count(*) from public.get_accounts_pending_deletion(100000) where user_id = :'ub')::int, 1,
  'account is then ready; the deleted scan on a live order does not hold it back');

-- stamp_stray_scans_deleted counts scans whose only orders are dead.
select checks15.eq(public.stamp_stray_scans_deleted(:'uc'), 2, 'stamp_stray stamps dead-order and unordered scans');
select checks15.eq(public.stamp_stray_scans_deleted(:'uc'), 0, 'stamp_stray counts only newly stamped scans');
reset role;
select checks15.eq((select status || '/' || (error->>'reason') from public.pipeline_jobs where scan_id = :'s_c1'),
  'dead_letter/account_deleted', 'stamp_stray dead-letters the stamped scan''s pending job');

-- A checkout opened after the deletion request is cancelled by the stamp,
-- and a payment that still lands is recorded for refund, not fulfilled.
insert into public.account_deletion_requests (user_id, reason) values (:'ud', 'user_request');
insert into public.orders (id, user_id, product_id, scan_id_left, status, amount_cents, stripe_checkout_session_id) values
  (:'o_d1', :'ud', :'prod', :'s_d1', 'pending_payment', 8900, 'cs_15_late');
set role service_role;
select checks15.eq(public.stamp_stray_scans_deleted(:'ud'), 1, 'stamp_stray counts scans, not the orders it cancels');
reset role;
select checks15.eq((select status from public.orders where id = :'o_d1'), 'cancelled',
  'stamp_stray cancels an open pending_payment order');
select checks15.eq((select deleted_at is not null from public.scans where id = :'s_d1'), true,
  'its scan is stamped as on a dead order');
set role service_role;
select checks15.eq(public.stripe_checkout_completed('evt_15_late', 'cs_15_late', 'pi_15_late', 8900, 'usd', null),
  'ignored', 'a late payment on the cancelled order is ignored');
reset role;
select checks15.eq((select status || '/' || (paid_at is not null) || '/' || stripe_payment_intent from public.orders where id = :'o_d1'),
  'cancelled/true/pi_15_late', 'the late payment is recorded for refund');
set role service_role;
select checks15.eq(public.purge_scan_row(:'s_d1', 'checks15'), false, 'a refundable order keeps its scan from the purge');
reset role;

-- ---------------------------------------------------------------------------
-- get_meshes_pending_deletion (30-day window).
-- ---------------------------------------------------------------------------
\set r_succ_old '15000000-4444-0000-0000-000000000001'
\set r_succ_new '15000000-4444-0000-0000-000000000002'
\set r_fail_old '15000000-4444-0000-0000-000000000003'
\set r_fail_new '15000000-4444-0000-0000-000000000004'
\set r_photo_old '15000000-4444-0000-0000-000000000005'
\set r_photo_new '15000000-4444-0000-0000-000000000006'
\set r_never_old '15000000-4444-0000-0000-000000000007'
\set r_never_new '15000000-4444-0000-0000-000000000008'
\set r_pending '15000000-4444-0000-0000-000000000009'
\set r_running '15000000-4444-0000-0000-00000000000a'
\set r_manual '15000000-4444-0000-0000-00000000000b'
\set r_gone '15000000-4444-0000-0000-00000000000c'

insert into public.scans (id, user_id, leg, status, capture_kind, mesh_path, mesh_deleted_at, created_at) values
  (:'r_succ_old', :'ua', 'L', 'uploaded', 'mesh', :'ua' || '/r1.obj', null, now() - interval '60 days'),
  (:'r_succ_new', :'ua', 'L', 'uploaded', 'mesh', :'ua' || '/r2.obj', null, now() - interval '60 days'),
  (:'r_fail_old', :'ua', 'L', 'uploaded', 'mesh', :'ua' || '/r3.obj', null, now() - interval '60 days'),
  (:'r_fail_new', :'ua', 'L', 'uploaded', 'mesh', :'ua' || '/r4.obj', null, now() - interval '60 days'),
  (:'r_photo_old', :'ua', 'L', 'uploaded', 'photos', null, null, now() - interval '60 days'),
  (:'r_photo_new', :'ua', 'L', 'uploaded', 'photos', null, null, now() - interval '60 days'),
  (:'r_never_old', :'ua', 'L', 'uploaded', 'mesh', :'ua' || '/r7.obj', null, now() - interval '40 days'),
  (:'r_never_new', :'ua', 'L', 'uploaded', 'photos', null, null, now() - interval '5 days'),
  (:'r_pending', :'ua', 'L', 'uploaded', 'mesh', :'ua' || '/r9.obj', null, now() - interval '60 days'),
  (:'r_running', :'ua', 'L', 'uploaded', 'photos', null, null, now() - interval '60 days'),
  -- mesh_path is client-writable (0012 "scans: update own"); manual still never qualifies.
  (:'r_manual', :'ua', 'L', 'uploaded', 'manual', :'ua' || '/r11.obj', null, now() - interval '60 days'),
  (:'r_gone', :'ua', 'L', 'uploaded', 'mesh', :'ua' || '/r12.obj', now() - interval '1 day', now() - interval '60 days');
insert into public.pipeline_jobs (scan_id, step, status, finished_at) values
  (:'r_succ_old', 'measuring', 'succeeded', now() - interval '40 days'),
  (:'r_succ_new', 'measuring', 'succeeded', now() - interval '5 days'),
  (:'r_fail_old', 'measuring', 'dead_letter', now() - interval '40 days'),
  (:'r_fail_new', 'measuring', 'dead_letter', now() - interval '5 days'),
  (:'r_photo_old', 'measuring', 'dead_letter', now() - interval '40 days'),
  (:'r_photo_new', 'measuring', 'dead_letter', now() - interval '5 days'),
  (:'r_pending', 'measuring', 'succeeded', now() - interval '40 days'),
  (:'r_pending', 'measuring', 'pending', null),
  (:'r_running', 'measuring', 'running', null),
  (:'r_manual', 'measuring', 'succeeded', now() - interval '40 days'),
  (:'r_gone', 'measuring', 'succeeded', now() - interval '40 days');

set role service_role;
create temp table r15 as
  select * from public.get_meshes_pending_deletion(30, 100000) where scan_id::text like '15000000-4444-%';
reset role;
select checks15.eq(
  (select string_agg(right(scan_id::text, 2), ',' order by scan_id) from r15),
  '01,03,05,07',
  'retention returns old succeeded, failed, photos and never-enqueued scans only');
select checks15.eq((select mesh_path is null from r15 where scan_id = :'r_photo_old'), true,
  'photos scan comes back with a null mesh_path');
select checks15.eq(
  (select (job_completed_at = (select created_at from public.scans where id = :'r_never_old')) from r15 where scan_id = :'r_never_old'),
  true, 'never-enqueued scan is timed from created_at');
select checks15.eq(
  (select (job_completed_at = (select finished_at from public.pipeline_jobs where scan_id = :'r_fail_old')) from r15 where scan_id = :'r_fail_old'),
  true, 'failed scan is timed from its dead-letter finish');

-- ---------------------------------------------------------------------------
-- Cleanup (deleted_at cannot be un-set after 0012, so rows are deleted).
-- ---------------------------------------------------------------------------
delete from public.pipeline_jobs where scan_id::text like '15000000-%';
delete from public.orders where id::text like '15000000-%';
delete from public.scans where id::text like '15000000-%';
delete from public.audit_log where actor = 'checks15' or subject_id::text like '15000000-%';
delete from public.products where id = :'prod';
delete from public.stripe_events where id = 'evt_15_late';
delete from auth.users where id in (:'ua', :'ub', :'uc', :'ud');
