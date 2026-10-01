-- Behavioral checks for 0013_orders_checkout.sql: Stripe webhook RPCs, order
-- cancellation, scan status sync, the client scan-status guard, enqueue
-- idempotency, the products column grant, admin retry and the waitlist.
-- Fixtures are written as the superuser; roles are switched only for the
-- privilege and guard checks. Run by run_sql_checks.sh.

\set ON_ERROR_STOP 1
\set QUIET 1

create schema checks13;
grant usage on schema checks13 to anon, authenticated, service_role;

create function checks13.expect_error(p_sql text, p_state text) returns void
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

create function checks13.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'check failed: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

grant execute on all functions in schema checks13 to anon, authenticated, service_role;

\set ua '13000000-0000-0000-0000-00000000000a'
\set ub '13000000-0000-0000-0000-00000000000b'
\set prod '13000000-1111-0000-0000-000000000001'
\set sc1 '13000000-2222-0000-0000-000000000001'
\set sc2 '13000000-2222-0000-0000-000000000002'
\set sc3 '13000000-2222-0000-0000-000000000003'
\set sc4 '13000000-2222-0000-0000-000000000004'
\set sc5 '13000000-2222-0000-0000-000000000005'
\set sc6 '13000000-2222-0000-0000-000000000006'
\set sc7 '13000000-2222-0000-0000-000000000007'
\set sc8 '13000000-2222-0000-0000-000000000008'
\set sc9 '13000000-2222-0000-0000-000000000009'
\set scdel '13000000-2222-0000-0000-0000000000dd'
\set scnm '13000000-2222-0000-0000-0000000000ee'
\set o_pay '13000000-3333-0000-0000-000000000001'
\set o_ship '13000000-3333-0000-0000-000000000002'
\set o_exp '13000000-3333-0000-0000-000000000003'
\set o_nm '13000000-3333-0000-0000-000000000004'

insert into auth.users (id) values (:'ua'), (:'ub');
insert into public.products (id, name, slug, base_price_cents, cad_model) values
  (:'prod', 'Guard13', 'guard-13', 8900, '{"provider":"dry_run","ref":{"document_id":"secret"}}');
insert into public.scans (id, user_id, leg, status) values
  (:'sc1', :'ua', 'L', 'uploaded'),
  (:'sc2', :'ua', 'R', 'uploaded'),
  (:'sc3', :'ua', 'L', 'uploaded'),
  (:'sc4', :'ua', 'R', 'uploaded'),
  (:'sc5', :'ua', 'L', 'uploaded'),
  (:'sc7', :'ua', 'L', 'capturing'),
  (:'sc9', :'ua', 'R', 'uploaded'),
  (:'scdel', :'ua', 'L', 'uploaded'),
  (:'scnm', :'ua', 'R', 'uploaded');
insert into public.scans (id, user_id, leg, status, capture_kind) values
  (:'sc6', :'ua', 'R', 'uploaded', 'photos');
insert into public.measurements (scan_id, schema_version, extraction_version, "values") values
  (:'sc1', '1.0.0', 'test', '{}'), (:'sc2', '1.0.0', 'test', '{}');
insert into public.orders (id, user_id, product_id, scan_id_left, scan_id_right, status, amount_cents, stripe_checkout_session_id) values
  (:'o_pay', :'ua', :'prod', :'sc1', :'sc2', 'pending_payment', 8900, 'cs_13_pay'),
  (:'o_ship', :'ua', :'prod', :'sc2', null, 'shipped', 8900, 'cs_13_ship'),
  (:'o_exp', :'ua', :'prod', :'sc1', null, 'pending_payment', 8900, 'cs_13_exp'),
  (:'o_nm', :'ua', :'prod', :'scnm', null, 'pending_payment', 8900, 'cs_13_nm');

-- ---------------------------------------------------------------------------
-- Privileges: no new function is client-callable; new tables unreachable.
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select checks13.expect_error('select public.stripe_checkout_completed(''e'', ''cs_13_pay'', ''pi'', 1, ''usd'', null)', '42501');
select checks13.expect_error('select public.stripe_checkout_expired(''e'', ''cs_13_pay'')', '42501');
select checks13.expect_error('select public.stripe_charge_refunded(''e'', ''pi'', true)', '42501');
select checks13.expect_error(format('select public.retry_pipeline_job(%L, %L)', :'sc1', 'x'), '42501');
select checks13.expect_error('select * from public.stripe_events', '42501');
select checks13.expect_error('insert into public.stripe_events (id, type) values (''evt_fake'', ''x'')', '42501');
select checks13.expect_error('select * from public.waitlist', '42501');
select checks13.expect_error('insert into public.waitlist (email) values (''a@b.co'')', '42501');
select checks13.expect_error('select cad_model from public.products', '42501');
select checks13.eq((select count(*) from public.products where id = :'prod')::int, 1, 'authenticated can still read catalog columns');
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select checks13.expect_error('select public.stripe_checkout_completed(''e'', ''cs_13_pay'', ''pi'', 1, ''usd'', null)', '42501');
select checks13.expect_error('select public.stripe_checkout_expired(''e'', ''cs_13_pay'')', '42501');
select checks13.expect_error('select public.stripe_charge_refunded(''e'', ''pi'', true)', '42501');
select checks13.expect_error(format('select public.retry_pipeline_job(%L, %L)', :'sc1', 'x'), '42501');
select checks13.expect_error(format('select public.enqueue_measure_job(%L)', :'sc1'), '42501');
select checks13.expect_error('select * from public.stripe_events', '42501');
select checks13.expect_error('select * from public.waitlist', '42501');
select checks13.expect_error('insert into public.waitlist (email) values (''a@b.co'')', '42501');
select checks13.expect_error('select cad_model from public.products', '42501');
select checks13.expect_error('select * from public.products', '42501');
select checks13.eq((select name from public.products where id = :'prod'), 'Guard13', 'anon can read product name');
reset role;

-- Trigger functions cannot be called directly, so check the grant itself.
select checks13.eq(
  (select bool_or(has_function_privilege(r, f, 'execute'))
     from unnest(array['anon', 'authenticated']) r,
          unnest(array['public.orders_cancel_pending_jobs()', 'public.pipeline_jobs_sync_scan_status()',
                       'public.scans_guard_client_status()']) f),
  false, 'anon/authenticated cannot execute the new trigger functions');

-- ---------------------------------------------------------------------------
-- C. stripe_checkout_completed
-- ---------------------------------------------------------------------------
set role service_role;
select checks13.eq(
  public.stripe_checkout_completed('evt_13_1', 'cs_13_pay', 'pi_13_1', 9900, 'usd', '{"line1":"x"}'),
  'applied', 'completed: pending order is applied');
reset role;
select checks13.eq(
  (select status || '/' || amount_cents || '/' || stripe_payment_intent || '/' || (paid_at is not null) || '/' || (address->>'line1')
     from public.orders where id = :'o_pay'),
  'paid/9900/pi_13_1/true/x', 'completed: status, amount, payment intent, paid_at and address written');
select checks13.eq(
  (select count(*) from public.pipeline_jobs where order_id = :'o_pay' and status = 'pending' and step = 'generating_cad')::int, 2,
  'completed: paid transition enqueues a CAD job per scan');
select checks13.eq(
  (select (detail->>'expected_amount_cents') || '/' || (detail->>'charged_amount_cents') || '/' || (detail->>'charged_currency')
            || '/' || (detail->>'expected_currency') || '/' || actor || '/' || subject_id::text
     from public.audit_log where detail->>'event_id' = 'evt_13_1'),
  '8900/9900/usd/usd/stripe-webhook/' || :'o_pay', 'completed: audit shows expected vs charged amount and currency');

select checks13.eq(
  public.stripe_checkout_completed('evt_13_1', 'cs_13_pay', 'pi_13_other', 1, 'eur', null),
  'duplicate', 'completed: redelivered event is a duplicate');
select checks13.eq(
  (select amount_cents || '/' || stripe_payment_intent from public.orders where id = :'o_pay'),
  '9900/pi_13_1', 'completed: duplicate changes nothing');
select checks13.eq(
  (select count(*) from public.audit_log where detail->>'event_id' = 'evt_13_1')::int, 1,
  'completed: duplicate writes no audit row');

select checks13.eq(
  public.stripe_checkout_completed('evt_13_2', 'cs_13_ship', 'pi_13_2', 1, 'usd', null),
  'ignored', 'completed: non-pending order is ignored');
select checks13.eq(
  (select status || '/' || amount_cents from public.orders where id = :'o_ship'),
  'shipped/8900', 'completed: ignored order unchanged');
select checks13.eq(
  (select count(*) from public.stripe_events where id = 'evt_13_2')::int, 1, 'completed: ignored event still recorded');
select checks13.eq(
  public.stripe_checkout_completed('evt_13_3', 'cs_13_missing', 'pi_13_3', 1, 'usd', null),
  'ignored', 'completed: unknown session is ignored');
select checks13.eq(
  (select count(*) from public.audit_log where detail->>'event_id' = 'evt_13_3' and subject_id is null)::int, 1,
  'completed: unknown session audited without subject');

-- The paid trigger refuses an unmeasured scan: nothing commits, not even the event.
select checks13.expect_error(
  'select public.stripe_checkout_completed(''evt_13_4'', ''cs_13_nm'', ''pi_13_4'', 8900, ''usd'', null)', '23514');
select checks13.eq((select count(*) from public.stripe_events where id = 'evt_13_4')::int, 0,
  'completed: failed apply leaves no event row');
select checks13.eq((select status from public.orders where id = :'o_nm'), 'pending_payment',
  'completed: failed apply leaves the order pending');

-- ---------------------------------------------------------------------------
-- C. stripe_checkout_expired
-- ---------------------------------------------------------------------------
select checks13.eq(public.stripe_checkout_expired('evt_13_5', 'cs_13_exp'), 'applied', 'expired: pending order applied');
select checks13.eq((select status from public.orders where id = :'o_exp'), 'cancelled', 'expired: order cancelled');
select checks13.eq(public.stripe_checkout_expired('evt_13_5', 'cs_13_exp'), 'duplicate', 'expired: duplicate');
select checks13.eq(public.stripe_checkout_expired('evt_13_6', 'cs_13_ship'), 'ignored', 'expired: non-pending ignored');
select checks13.eq((select status from public.orders where id = :'o_ship'), 'shipped', 'expired: ignored order unchanged');

-- Payment that lands after the order was cancelled: still cancelled, but the
-- charge is recorded so the admin refund path can see it.
select checks13.eq(public.stripe_checkout_completed('evt_13_5b', 'cs_13_exp', 'pi_13_late', 8900, 'usd', null),
  'ignored', 'completed: payment on a cancelled order is ignored');
select checks13.eq(
  (select status || '/' || stripe_payment_intent || '/' || amount_cents || '/' || (paid_at is not null) from public.orders where id = :'o_exp'),
  'cancelled/pi_13_late/8900/true', 'completed: late payment recorded on the cancelled order for refund');
select checks13.eq((select (detail->>'needs_refund') from public.audit_log where detail->>'event_id' = 'evt_13_5b'),
  'true', 'completed: late payment audited as needing a refund');
select checks13.eq((select count(*) from public.pipeline_jobs where order_id = :'o_exp')::int, 0,
  'completed: late payment enqueues no CAD');

-- ---------------------------------------------------------------------------
-- C. stripe_charge_refunded
-- ---------------------------------------------------------------------------
select checks13.eq(public.stripe_charge_refunded('evt_13_7', 'pi_13_1', false), 'applied', 'refund: partial applied');
select checks13.eq((select refunded_at from public.orders where id = :'o_pay'), null::timestamptz, 'refund: partial leaves refunded_at null');
select checks13.eq((select count(*) from public.audit_log where detail->>'event_id' = 'evt_13_7')::int, 1, 'refund: partial audited');
select checks13.eq(public.stripe_charge_refunded('evt_13_8', 'pi_13_1', true), 'applied', 'refund: full applied');
select checks13.eq(
  (select (refunded_at is not null) || '/' || status from public.orders where id = :'o_pay'),
  'true/paid', 'refund: full sets refunded_at, status unchanged');
select checks13.eq(public.stripe_charge_refunded('evt_13_8', 'pi_13_1', true), 'duplicate', 'refund: duplicate');
select checks13.eq(public.stripe_charge_refunded('evt_13_9', 'pi_13_missing', true), 'ignored', 'refund: unknown intent ignored');

-- ---------------------------------------------------------------------------
-- D. Cancellation dead-letters pending CAD jobs, leaves running ones.
-- CAD jobs never touch scan status (E is measure jobs only).
-- ---------------------------------------------------------------------------
select checks13.eq(
  (select string_agg(status, ',' order by id) from public.scans where id in (:'sc1', :'sc2')),
  'uploaded,uploaded', 'CAD jobs do not change scan status');
update public.pipeline_jobs set status = 'running', locked_by = 'w' where order_id = :'o_pay' and scan_id = :'sc2';
update public.orders set status = 'cancelled' where id = :'o_pay';
select checks13.eq(
  (select status || '/' || (error->>'reason') from public.pipeline_jobs where order_id = :'o_pay' and scan_id = :'sc1'),
  'dead_letter/order_cancelled', 'cancel: pending CAD job dead-lettered');
select checks13.eq(
  (select status from public.pipeline_jobs where order_id = :'o_pay' and scan_id = :'sc2'),
  'running', 'cancel: running CAD job left to finish');
select checks13.eq(
  (select string_agg(status, ',' order by id) from public.scans where id in (:'sc1', :'sc2')),
  'uploaded,uploaded', 'dead-lettered CAD job does not change scan status');

-- ---------------------------------------------------------------------------
-- E. Scan status follows the measure job.
-- ---------------------------------------------------------------------------
insert into public.pipeline_jobs (scan_id, step) values (:'sc3', 'measuring');
select id as j3 from public.pipeline_jobs where scan_id = :'sc3' \gset
select checks13.eq((select status from public.scans where id = :'sc3'), 'processing', 'E: pending measure job -> processing');
select public.fail_pipeline_job(:'j3', '{"reason":"bad_mesh"}', false) \g /dev/null
select checks13.eq((select status || '/' || failed_step from public.scans where id = :'sc3'), 'failed/measuring',
  'E: dead_letter -> failed with failed_step');

insert into public.pipeline_jobs (scan_id, step) values (:'sc5', 'measuring');
select id as j5 from public.pipeline_jobs where scan_id = :'sc5' \gset
select public.complete_pipeline_job(:'j5', 'measured') \g /dev/null
select checks13.eq((select status || '/' || coalesce(failed_step, '-') from public.scans where id = :'sc5'), 'ready/-',
  'E: succeeded -> ready');

insert into public.pipeline_jobs (scan_id, step, status) values (:'sc6', 'reconstructing', 'dead_letter');
select id as j6 from public.pipeline_jobs where scan_id = :'sc6' \gset
select checks13.eq((select status || '/' || failed_step from public.scans where id = :'sc6'), 'failed/reconstructing',
  'E: reconstruct dead_letter -> failed_step reconstructing');

insert into public.pipeline_jobs (scan_id, step) values (:'sc7', 'measuring');
select checks13.eq((select status from public.scans where id = :'sc7'), 'capturing', 'E: capturing scan not moved to processing');
update public.pipeline_jobs set status = 'failed' where scan_id = :'sc7';
select checks13.eq((select status from public.scans where id = :'sc7'), 'capturing', 'E: other job statuses are a no-op');

-- ---------------------------------------------------------------------------
-- I. retry_pipeline_job
-- ---------------------------------------------------------------------------
set role service_role;
select checks13.expect_error(format('select public.retry_pipeline_job(%L, %L)', :'j5', 'admin'), '23514');
select checks13.expect_error(format('select public.retry_pipeline_job(%L, %L)', :'sc1', 'admin'), '23514');
select checks13.expect_error(format('select public.retry_pipeline_job(%L, %L)',
  (select id from public.pipeline_jobs where order_id = :'o_pay' and scan_id = :'sc1'), 'admin'), '23514');
reset role;

insert into public.pipeline_jobs (scan_id, step, status) values (:'scdel', 'measuring', 'dead_letter');
update public.scans set deleted_at = now() where id = :'scdel';
set role service_role;
select checks13.expect_error(format('select public.retry_pipeline_job(%L, %L)',
  (select id from public.pipeline_jobs where scan_id = :'scdel'), 'admin'), '23514');
reset role;

insert into public.pipeline_jobs (scan_id, step, status) values (:'sc4', 'measuring', 'dead_letter');
select id as j4 from public.pipeline_jobs where scan_id = :'sc4' \gset
insert into public.pipeline_jobs (scan_id, step) values (:'sc4', 'measuring');
set role service_role;
select checks13.expect_error(format('select public.retry_pipeline_job(%L, %L)', :'j4', 'admin'), '23505');

update public.pipeline_jobs set attempts = 3, locked_by = 'w', locked_at = now() where id = :'j3';
select (public.retry_pipeline_job(:'j3', 'admin-13')).status as retried \gset
reset role;
select checks13.eq(:'retried'::text, 'pending', 'retry: returns the job as pending');
select checks13.eq(
  (select status || '/' || step || '/' || attempts || '/' || coalesce(error::text, '-') || '/' || (finished_at is null)
          || '/' || coalesce(locked_by, '-') || '/' || (locked_at is null)
     from public.pipeline_jobs where id = :'j3'),
  'pending/measuring/0/-/true/-/true', 'retry: reset at the failed step');
select checks13.eq(
  (select (detail->'previous_error'->>'reason') || '/' || (detail->>'step') || '/' || subject_table
     from public.audit_log where action = 'pipeline_job.retry' and actor = 'admin-13' and subject_id = :'j3'),
  'bad_mesh/measuring/pipeline_jobs', 'retry: audited with previous error and step');
select checks13.eq((select status || '/' || coalesce(failed_step, '-') from public.scans where id = :'sc3'), 'processing/-',
  'retry: measure scan back to processing');

-- ---------------------------------------------------------------------------
-- F. Client scan-status guard. G. enqueue idempotency.
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select checks13.expect_error(format(
  'insert into public.scans (user_id, leg, status) values (%L, %L, %L)', :'ua', 'L', 'processing'), '23514');
select checks13.expect_error(format(
  'insert into public.scans (user_id, leg, status) values (%L, %L, %L)', :'ua', 'L', 'ready'), '23514');
insert into public.scans (id, user_id, leg, status, failed_step, mesh_deleted_at)
  values (:'sc8', :'ua', 'L', 'capturing', 'measuring', now());
select checks13.eq((select coalesce(failed_step, '-') || '/' || (mesh_deleted_at is null) from public.scans where id = :'sc8'),
  '-/true', 'F: client insert cannot set failed_step or mesh_deleted_at');

update public.scans set status = 'uploaded' where id = :'sc8';
select checks13.eq((select status from public.scans where id = :'sc8'), 'uploaded', 'F: capturing -> uploaded allowed');

select public.enqueue_measure_job(:'sc8') as j8 \gset
select checks13.eq((select status from public.scans where id = :'sc8'), 'processing', 'G: enqueue moves scan to processing');
select checks13.eq(public.enqueue_measure_job(:'sc8'), :'j8'::uuid, 'G: retry on processing scan returns the existing job');

-- The app's upload retry re-upserts status 'uploaded': succeeds, status kept.
insert into public.scans (id, user_id, leg, status) values (:'sc8', :'ua', 'L', 'uploaded')
  on conflict (id) do update set status = excluded.status;
select checks13.eq((select status from public.scans where id = :'sc8'), 'processing', 'F: upsert retry keeps processing');

update public.scans set status = 'uploaded', failed_step = 'measuring', mesh_deleted_at = now() where id = :'sc5';
select checks13.eq(
  (select status || '/' || coalesce(failed_step, '-') || '/' || (mesh_deleted_at is null) from public.scans where id = :'sc5'),
  'ready/-/true', 'F: client update cannot change status, failed_step or mesh_deleted_at');
update public.scans set status = 'ready' where id = :'sc3';
select checks13.eq((select status from public.scans where id = :'sc3'), 'processing', 'F: client cannot mark a scan ready');

select checks13.eq(public.enqueue_measure_job(:'sc5'), :'j5'::uuid, 'G: ready scan returns its latest measure job');
select checks13.eq(public.enqueue_measure_job(:'sc6'), :'j6'::uuid, 'G: failed scan returns its latest measure job');
select checks13.expect_error(format('select public.enqueue_measure_job(%L)', :'sc7'), '23514');

select set_config('request.jwt.claim.sub', :'ub', false);
select checks13.expect_error(format('select public.enqueue_measure_job(%L)', :'sc5'), '42501');
select set_config('request.jwt.claim.sub', :'ua', false);

-- deleted_at is not the guard's business: the deletion RPC still stamps it,
-- and its dead-lettering (definer) still moves the scan to failed.
insert into public.scans (id, user_id, leg, status) values ('13000000-2222-0000-0000-0000000000ab', :'ua', 'L', 'uploaded');
select public.enqueue_measure_job('13000000-2222-0000-0000-0000000000ab') \g /dev/null
select public.request_scan_deletion(array['13000000-2222-0000-0000-0000000000ab']::uuid[]);
reset role;
select checks13.eq(
  (select status || '/' || (deleted_at is not null) from public.scans where id = '13000000-2222-0000-0000-0000000000ab'),
  'failed/true', 'F: definer paths (request_scan_deletion, E) are unaffected by the guard');

-- Service role (the worker) is unaffected.
set role service_role;
update public.scans set status = 'failed', failed_step = 'measuring' where id = :'sc9';
reset role;
select checks13.eq((select status || '/' || failed_step from public.scans where id = :'sc9'), 'failed/measuring',
  'F: service role can set status and failed_step');
select checks13.expect_error(format('update public.scans set failed_step = %L where id = %L', 'printing', :'sc9'), '23514');

-- ---------------------------------------------------------------------------
-- J. waitlist (service role)
-- ---------------------------------------------------------------------------
set role service_role;
insert into public.waitlist (email) values ('Kid@Example.com');
insert into public.waitlist (email, interest) values ('kid@example.com', 'pro');
select checks13.expect_error('insert into public.waitlist (email) values (''kid@EXAMPLE.com'')', '23505');
select checks13.expect_error('insert into public.waitlist (email) values (''not-an-email'')', '23514');
select checks13.expect_error('insert into public.waitlist (email, interest) values (''a@b.co'', ''vip'')', '23514');
select checks13.eq((select count(*) from public.waitlist where lower(email) = 'kid@example.com')::int, 2,
  'waitlist: one row per (email, interest)');
reset role;

-- scan_deletion_checks.sql runs after this file and counts deleted scans
-- globally. 0012 freezes deleted_at once set, so remove this file's deleted
-- fixtures (and what references them) instead of un-stamping them.
delete from public.orders where user_id = :'ua'
  and (scan_id_left in (select id from public.scans where user_id = :'ua' and deleted_at is not null)
    or scan_id_right in (select id from public.scans where user_id = :'ua' and deleted_at is not null));
delete from public.scans where user_id = :'ua' and deleted_at is not null;
