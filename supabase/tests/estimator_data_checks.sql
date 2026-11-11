-- Behavioral checks for 0018_measurement_quality.sql, 0019_leg_models.sql and
-- 0021_refuse_and_snapshot.sql: RLS and grants on the new tables, the jsonb
-- envelope checks, uniqueness and cascades, export_my_data, the
-- accepted_measurement rule, request_scan_refusion (refusals, idempotency,
-- grants), and the order snapshot on every path to paid, above all that a
-- payment is never blocked by it. Fixtures are written as the superuser;
-- roles are switched only for the privilege checks. Run by run_sql_checks.sh.

\set ON_ERROR_STOP 1
\set QUIET 1

create schema checks18;
grant usage on schema checks18 to anon, authenticated, service_role;

create function checks18.expect_error(p_sql text, p_state text) returns void
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

-- RLS hides rows silently on update and delete, so "denied" there means zero
-- rows touched.
create function checks18.rows_affected(p_sql text) returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function checks18.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'check failed: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

-- 25 numeric values in the frozen key shape (Leg_Length + S1-S4 x 6 dims).
-- The numbers are arbitrary: SQL never checks names or ranges.
create function checks18.values25(p_base numeric) returns jsonb
language sql immutable as $$
  select jsonb_object_agg(k, p_base + n)
  from (
    select 'Leg_Length' as k, 0 as n
    union all
    select format('S%s_%s', s, d), s * 10 + i
    from generate_series(1, 4) s,
      unnest(array['ISW', 'ISD', 'ICW', 'ICD', 'OW', 'OD']) with ordinality as t(d, i)
  ) x;
$$;

grant execute on all functions in schema checks18 to anon, authenticated, service_role;

\set ua '18000000-0000-0000-0000-00000000000a'
\set ub '18000000-0000-0000-0000-00000000000b'
\set p '18000000-1111-0000-0000-000000000001'
-- accepted_measurement, quality and leg model fixtures
\set s_acc '18000000-2222-0000-0000-000000000001'
\set s_none '18000000-2222-0000-0000-000000000002'
\set s_casc '18000000-2222-0000-0000-000000000003'
\set s_b '18000000-2222-0000-0000-000000000004'
-- request_scan_refusion fixtures
\set s_ref '18000000-2222-0000-0000-000000000011'
\set s_proc '18000000-2222-0000-0000-000000000012'
\set s_man '18000000-2222-0000-0000-000000000013'
\set s_paid '18000000-2222-0000-0000-000000000014'
\set s_gone '18000000-2222-0000-0000-000000000015'
\set s_del '18000000-2222-0000-0000-000000000016'
\set s_pend '18000000-2222-0000-0000-000000000017'
\set s_remk '18000000-2222-0000-0000-000000000018'
-- snapshot fixtures
\set sn_l '18000000-2222-0000-0000-000000000021'
\set sn_r '18000000-2222-0000-0000-000000000022'
\set sn_unval '18000000-2222-0000-0000-000000000023'
\set sn_sup '18000000-2222-0000-0000-000000000024'
\set sn_bad '18000000-2222-0000-0000-000000000025'
\set sn_str '18000000-2222-0000-0000-000000000026'
\set sn_fail '18000000-2222-0000-0000-000000000027'
\set sn_zero '18000000-2222-0000-0000-000000000028'
\set m_old '18000000-3333-0000-0000-000000000001'
\set m_sup '18000000-3333-0000-0000-000000000002'
\set m_unval '18000000-3333-0000-0000-000000000003'
\set m_casc1 '18000000-3333-0000-0000-000000000004'
\set m_casc2 '18000000-3333-0000-0000-000000000005'
\set m_l '18000000-3333-0000-0000-000000000006'
\set m_r '18000000-3333-0000-0000-000000000007'
\set m_b '18000000-3333-0000-0000-000000000008'
\set lm_l '18000000-4444-0000-0000-000000000001'
\set lm_acc '18000000-4444-0000-0000-000000000002'
\set lm_b '18000000-4444-0000-0000-000000000003'
\set o_pair '18000000-5555-0000-0000-000000000001'
\set o_unval '18000000-5555-0000-0000-000000000002'
\set o_sup '18000000-5555-0000-0000-000000000003'
\set o_bad '18000000-5555-0000-0000-000000000004'
\set o_fail '18000000-5555-0000-0000-000000000005'
\set o_zero '18000000-5555-0000-0000-000000000006'
\set o_paidfx '18000000-5555-0000-0000-000000000007'
\set o_pend '18000000-5555-0000-0000-000000000008'
\set o_remkfx '18000000-5555-0000-0000-000000000009'

insert into auth.users (id, email, is_anonymous) values
  (:'ua', 'est.alpha@example.test', false),
  (:'ub', 'est.beta@example.test', false);

insert into public.products (id, name, slug, base_price_cents, availability, cad_model) values
  (:'p', 'Est18', 'est-18', 8900, 'available', '{"provider":"dry_run"}');

insert into public.scans (id, user_id, leg, status) values
  (:'s_acc', :'ua', 'L', 'ready'),
  (:'s_none', :'ua', 'L', 'ready'),
  (:'s_casc', :'ua', 'R', 'ready'),
  (:'s_b', :'ub', 'L', 'ready'),
  (:'s_ref', :'ua', 'L', 'ready'),
  (:'s_proc', :'ua', 'L', 'processing'),
  (:'s_man', :'ua', 'L', 'ready'),
  (:'s_paid', :'ua', 'L', 'ready'),
  (:'s_gone', :'ua', 'L', 'ready'),
  (:'s_del', :'ua', 'L', 'ready'),
  (:'s_pend', :'ua', 'L', 'ready'),
  (:'s_remk', :'ua', 'L', 'ready'),
  (:'sn_l', :'ua', 'L', 'ready'),
  (:'sn_r', :'ua', 'R', 'ready'),
  (:'sn_unval', :'ua', 'L', 'ready'),
  (:'sn_sup', :'ua', 'L', 'ready'),
  (:'sn_bad', :'ua', 'L', 'ready'),
  (:'sn_str', :'ua', 'R', 'ready'),
  (:'sn_fail', :'ua', 'L', 'ready'),
  (:'sn_zero', :'ua', 'L', 'ready');
update public.scans set mesh_deleted_at = now() where id = :'s_gone';
update public.scans set deleted_at = now() where id = :'s_del';

-- s_acc: an older accepted row, a newer superseded one, a newest unvalidated
-- one. The rule must pick the older accepted row.
insert into public.measurements
  (id, scan_id, schema_version, extraction_version, "values", validated, created_at, superseded_at)
values
  (:'m_old', :'s_acc', '1.1.0', 'v1', checks18.values25(10), true, now() - interval '3 hours', null),
  (:'m_sup', :'s_acc', '1.1.0', 'v2', checks18.values25(20), true, now() - interval '2 hours', now()),
  (:'m_unval', :'s_acc', '1.1.0', 'v3', checks18.values25(30), false, now() - interval '1 hour', null),
  (:'m_casc1', :'s_casc', '1.1.0', 'v1', checks18.values25(40), true, now(), null),
  (:'m_casc2', :'s_casc', '1.1.0', 'v2', checks18.values25(41), true, now(), null),
  (:'m_b', :'s_b', '1.1.0', 'v1', checks18.values25(50), true, now(), null),
  (:'m_l', :'sn_l', '1.1.0', 'v1', checks18.values25(100), true, now() - interval '1 hour', null),
  (:'m_r', :'sn_r', '1.1.0', 'v1', checks18.values25(200), true, now() - interval '1 hour', null);

insert into public.measurements (scan_id, schema_version, extraction_version, "values", validated, superseded_at, source)
values
  (:'s_ref', '1.1.0', 'v1', checks18.values25(60), true, null, 'scan'),
  (:'s_man', '1.1.0', 'manual-1', checks18.values25(61), true, null, 'manual'),
  (:'s_paid', '1.1.0', 'v1', checks18.values25(62), true, null, 'scan'),
  (:'s_pend', '1.1.0', 'v1', checks18.values25(63), true, null, 'scan'),
  (:'s_remk', '1.1.0', 'v1', checks18.values25(64), true, null, 'scan'),
  (:'sn_unval', '1.1.0', 'v1', checks18.values25(300), false, null, 'scan'),
  (:'sn_sup', '1.1.0', 'v1', checks18.values25(400), true, now(), 'scan'),
  (:'sn_bad', '1.1.0', 'v1', '[1, 2]', true, null, 'scan'),
  (:'sn_str', '1.1.0', 'v1', checks18.values25(500) || '{"Leg_Length": "x"}', true, null, 'scan'),
  (:'sn_fail', '1.1.0', 'v1', checks18.values25(600), true, null, 'scan');

-- ===========================================================================
-- 0018 measurement_quality
-- ===========================================================================
insert into public.measurement_quality (measurement_id, quality)
values (:'m_old', '{"format":"forms.measurement-quality","version":1,"verdict":"none"}');
select checks18.eq((select count(*) from public.measurement_quality where measurement_id = :'m_old')::int, 1,
  'a well-formed quality document is stored');

select checks18.expect_error(format(
  'insert into public.measurement_quality (measurement_id, quality) values (%L, %L)',
  :'m_old', '{"format":"forms.measurement-quality","version":1}'), '23505');
select checks18.eq(true, true, 'quality is unique per measurement');

select checks18.expect_error(format(
  'insert into public.measurement_quality (measurement_id, quality) values (%L, %L)', :'m_sup', q), '23514')
  from unnest(array[
    '{"format":"forms.leg-model","version":1}',
    '{"format":"forms.measurement-quality","version":2}',
    '{"format":"forms.measurement-quality","version":"1"}',
    '{"format":"forms.measurement-quality","version":1.5}',
    '{"format":"forms.measurement-quality"}',
    '{"version":1}',
    '[]',
    'null',
    '"forms.measurement-quality"']) q;
select checks18.eq(true, true, 'quality refuses a wrong format, a wrong or missing version, and non-objects');

select checks18.expect_error(format(
  'insert into public.measurement_quality (measurement_id, quality) values (%L, %L)', :'m_sup',
  jsonb_build_object('format', 'forms.measurement-quality', 'version', 1, 'pad', repeat('x', 17000))), '23514');
select checks18.eq(true, true, 'quality refuses an oversize document');

-- Cascades: measurement delete takes its quality; scan delete takes both.
insert into public.measurement_quality (measurement_id, quality) values
  (:'m_casc1', '{"format":"forms.measurement-quality","version":1}'),
  (:'m_casc2', '{"format":"forms.measurement-quality","version":1}');
delete from public.measurements where id = :'m_casc1';
select checks18.eq((select count(*) from public.measurement_quality where measurement_id = :'m_casc1')::int, 0,
  'deleting a measurement cascades to its quality');

-- ===========================================================================
-- 0019 leg_models
-- ===========================================================================
insert into public.leg_models (id, scan_id, extraction_version, model) values
  (:'lm_acc', :'s_acc', 'v1', '{"format":"forms.leg-model","version":1,"leg":"L"}'),
  (:'lm_b', :'s_b', 'v1', '{"format":"forms.leg-model","version":1,"leg":"L"}'),
  (:'lm_l', :'sn_l', 'v1', '{"format":"forms.leg-model","version":1,"leg":"L"}');
insert into public.leg_models (scan_id, extraction_version, model) values
  (:'s_casc', 'v2', '{"format":"forms.leg-model","version":1,"leg":"R"}');

select checks18.expect_error(format(
  'insert into public.leg_models (scan_id, extraction_version, model) values (%L, %L, %L)',
  :'s_acc', 'v1', '{"format":"forms.leg-model","version":1}'), '23505');
select checks18.eq(true, true, 'leg_models is unique per (scan, extraction_version)');

select checks18.expect_error(format(
  'insert into public.leg_models (scan_id, extraction_version, model) values (%L, %L, %L)', :'s_acc', 'vx', m), '23514')
  from unnest(array[
    '{"format":"forms.measurement-quality","version":1}',
    '{"format":"forms.leg-model","version":2}',
    '{"format":"forms.leg-model","version":"1"}',
    '{"format":"forms.leg-model","version":1.0}',
    '{"format":"forms.leg-model"}',
    '[]',
    'null']) m;
select checks18.eq(true, true, 'leg_models refuses a wrong format, a wrong or missing version, and non-objects');

select checks18.expect_error(format(
  'insert into public.leg_models (scan_id, extraction_version, model) values (%L, %L, %L)', :'s_acc', 'vbig',
  jsonb_build_object('format', 'forms.leg-model', 'version', 1, 'pad', repeat('x', 140000))), '23514');
select checks18.expect_error(format(
  'insert into public.leg_models (scan_id, extraction_version, model) values (%L, %L, %L)', :'s_acc', '',
  '{"format":"forms.leg-model","version":1}'), '23514');
select checks18.eq(true, true, 'leg_models refuses an oversize model and an empty extraction_version');

delete from public.scans where id = :'s_casc';
select checks18.eq(
  (select count(*) from public.measurements where scan_id = :'s_casc')::int
    + (select count(*) from public.measurement_quality where measurement_id = :'m_casc2')::int
    + (select count(*) from public.leg_models where scan_id = :'s_casc')::int, 0,
  'deleting a scan cascades to its measurements, their quality and its leg models');

-- ---------------------------------------------------------------------------
-- RLS and grants on both tables
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select checks18.eq((select count(*) from public.leg_models)::int, 2, 'owner sees exactly their own leg models');
select checks18.eq((select count(*) from public.leg_models where id = :'lm_b')::int, 0,
  'owner does not see another user''s leg model');
select checks18.expect_error('select count(*) from public.measurement_quality', '42501');
select checks18.eq(true, true, 'owner cannot read measurement_quality');
select checks18.expect_error(format(
  'insert into public.leg_models (scan_id, extraction_version, model) values (%L, %L, %L)',
  :'s_acc', 'client', '{"format":"forms.leg-model","version":1}'), '42501');
select checks18.expect_error(format('update public.leg_models set extraction_version = %L where id = %L', 'x', :'lm_acc'), '42501');
select checks18.expect_error(format('delete from public.leg_models where id = %L', :'lm_acc'), '42501');
select checks18.eq(true, true, 'owner cannot insert, update or delete leg models');
select checks18.expect_error(format(
  'insert into public.measurement_quality (measurement_id, quality) values (%L, %L)',
  :'m_l', '{"format":"forms.measurement-quality","version":1}'), '42501');
select checks18.expect_error(format('update public.measurement_quality set quality = quality where measurement_id = %L', :'m_old'), '42501');
select checks18.expect_error(format('delete from public.measurement_quality where measurement_id = %L', :'m_old'), '42501');
select checks18.eq(true, true, 'owner cannot insert, update or delete measurement_quality');

select set_config('request.jwt.claim.sub', :'ub', false);
select checks18.eq((select count(*) from public.leg_models where scan_id in (:'s_acc', :'sn_l'))::int, 0,
  'another user sees none of the owner''s leg models');
select checks18.expect_error('select count(*) from public.measurement_quality', '42501');
select checks18.eq(true, true, 'another user cannot read measurement_quality');
reset role;

set role anon;
select set_config('request.jwt.claim.sub', '', false);
select checks18.expect_error('select count(*) from public.leg_models', '42501');
select checks18.expect_error('select count(*) from public.measurement_quality', '42501');
select checks18.eq(true, true, 'anon can read neither table');
reset role;

-- ---------------------------------------------------------------------------
-- export_my_data includes the caller's leg models only
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select public.export_my_data() as ua_export \gset
select set_config('request.jwt.claim.sub', :'ub', false);
select public.export_my_data() as ub_export \gset
reset role;

select checks18.eq(jsonb_array_length(:'ua_export'::jsonb -> 'leg_models'), 2, 'export holds the caller''s two leg models');
select checks18.eq(
  (select array_agg(e ->> 'scan_id' order by e ->> 'scan_id')
     from jsonb_array_elements(:'ua_export'::jsonb -> 'leg_models') e),
  array[:'s_acc', :'sn_l'], 'export leg models are the caller''s scans');
select checks18.eq((:'ua_export'::jsonb #>> '{leg_models,0,model,format}'), 'forms.leg-model',
  'export carries the model document');
select checks18.eq(position(:'s_b' in :'ua_export'), 0, 'export holds nothing of another user');
select checks18.eq(
  (select array_agg(e ->> 'scan_id') from jsonb_array_elements(:'ub_export'::jsonb -> 'leg_models') e),
  array[:'s_b'], 'the other user''s export holds only their own leg model');
select checks18.eq(
  (select array_agg(k order by k) from jsonb_object_keys(:'ua_export'::jsonb) k),
  array['account', 'exported_at', 'leg_models', 'measurements', 'orders', 'profile', 'scans'],
  'export keeps every 0012 section and adds leg_models');
select checks18.eq(position('measurement-quality' in :'ua_export'), 0, 'export holds no quality documents');

-- ===========================================================================
-- 0018 accepted_measurement
-- ===========================================================================
select checks18.eq((public.accepted_measurement(:'s_acc')).id, :'m_old'::uuid,
  'accepted_measurement skips superseded and unvalidated rows');
select checks18.eq(public.accepted_measurement(:'s_none') is null, true,
  'accepted_measurement is null for a scan with no rows');
select checks18.eq(public.accepted_measurement(:'sn_sup') is null and public.accepted_measurement(:'sn_unval') is null,
  true, 'accepted_measurement is null when every row is superseded or unvalidated');
update public.measurements set superseded_at = now() where id = :'m_old';
select checks18.eq(public.accepted_measurement(:'s_acc') is null, true,
  'accepted_measurement is null once the accepted row is superseded');
update public.measurements set superseded_at = null where id = :'m_old';

set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select checks18.eq((public.accepted_measurement(:'s_acc')).id, :'m_old'::uuid, 'owner reads their accepted row');
select checks18.eq(public.accepted_measurement(:'s_b') is null, true, 'owner gets null for another user''s scan');
reset role;
set role anon;
select checks18.expect_error(format('select public.accepted_measurement(%L)', :'s_acc'), '42501');
select checks18.eq(true, true, 'anon cannot call accepted_measurement');
reset role;

-- ===========================================================================
-- 0021 A request_scan_refusion
-- ===========================================================================
insert into public.orders (id, user_id, product_id, scan_id_left, status, amount_cents, paid_at) values
  (:'o_paidfx', :'ua', :'p', :'s_paid', 'in_production', 8900, now()),
  (:'o_pend', :'ua', :'p', :'s_pend', 'pending_payment', 8900, null),
  -- Cancelled after the charge landed (0013): still a paid order.
  (:'o_remkfx', :'ua', :'p', :'s_remk', 'cancelled', 8900, now());

set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select public.request_scan_refusion(:'s_ref') as job1 \gset
select public.request_scan_refusion(:'s_ref') as job2 \gset
select checks18.eq(:'job1'::uuid is not null, true, 'refusion of the owner''s ready scan returns a job');
select checks18.eq(:'job2'::uuid, :'job1'::uuid, 'a second call returns the same active job');

select checks18.expect_error(format('select public.request_scan_refusion(%L)', :'s_b'), '42501');
select checks18.expect_error(format('select public.request_scan_refusion(%L)', '18000000-2222-0000-0000-0000000000ff'), '42501');
select checks18.eq(true, true, 'refusion refuses another user''s scan and a missing one alike');
select checks18.expect_error(format('select public.request_scan_refusion(%L)', :'s_proc'), '23514');
select checks18.eq(true, true, 'refusion refuses a scan that is not ready');
select checks18.expect_error(format('select public.request_scan_refusion(%L)', :'s_man'), '23514');
select checks18.eq(true, true, 'refusion refuses a scan with a manual row');
select checks18.expect_error(format('select public.request_scan_refusion(%L)', :'s_paid'), '23514');
select checks18.expect_error(format('select public.request_scan_refusion(%L)', :'s_remk'), '23514');
select checks18.eq(true, true, 'refusion refuses a scan on a paid order, including one cancelled after payment');
select checks18.expect_error(format('select public.request_scan_refusion(%L)', :'s_gone'), '23514');
select checks18.expect_error(format('select public.request_scan_refusion(%L)', :'s_del'), '23514');
select checks18.eq(true, true, 'refusion refuses an erased capture and a deleted scan');
select checks18.expect_error('select public.request_scan_refusion(null)', '22023');
select public.request_scan_refusion(:'s_pend') as job_pend \gset
select checks18.eq(:'job_pend'::uuid is not null, true, 'refusion accepts a scan on an unpaid (pending) order');

select set_config('request.jwt.claim.sub', '', false);
select checks18.expect_error(format('select public.request_scan_refusion(%L)', :'s_ref'), '42501');
select checks18.eq(true, true, 'refusion refuses a request with no session');
reset role;

set role anon;
select checks18.expect_error(format('select public.request_scan_refusion(%L)', :'s_ref'), '42501');
select checks18.eq(true, true, 'anon cannot execute request_scan_refusion');
reset role;

select checks18.eq(
  (select format('%s/%s/%s/%s', count(*), min(step), min(status), bool_and(product_id is null))
     from public.pipeline_jobs where scan_id = :'s_ref'),
  '1/measuring/pending/t', 'refusion enqueued exactly one pending measure job');
select checks18.eq((select status from public.scans where id = :'s_ref'), 'processing',
  'the refusion job moves the scan to processing (0013 E)');
select checks18.eq((select count(*) from public.pipeline_jobs
  where scan_id in (:'s_b', :'s_proc', :'s_man', :'s_paid', :'s_remk', :'s_gone', :'s_del'))::int, 0,
  'no refused call enqueued a job');

-- After the job finishes the scan is ready again and a fresh call enqueues anew.
update public.pipeline_jobs set status = 'succeeded', finished_at = now() where id = :'job1';
set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select public.request_scan_refusion(:'s_ref') as job3 \gset
reset role;
select checks18.eq(:'job3'::uuid <> :'job1'::uuid, true, 'a finished job lets a later refusion enqueue a new one');

-- ===========================================================================
-- 0021 B order snapshot
-- ===========================================================================
insert into public.orders (id, user_id, product_id, scan_id_left, scan_id_right, status, amount_cents, stripe_checkout_session_id)
values
  (:'o_pair', :'ua', :'p', :'sn_l', :'sn_r', 'pending_payment', 17800, 'cs_est18_pair'),
  (:'o_unval', :'ua', :'p', :'sn_unval', null, 'pending_payment', 8900, null),
  (:'o_sup', :'ua', :'p', :'sn_sup', null, 'pending_payment', 8900, null),
  (:'o_bad', :'ua', :'p', :'sn_bad', :'sn_str', 'pending_payment', 17800, null),
  (:'o_fail', :'ua', :'p', :'sn_fail', null, 'pending_payment', 8900, null),
  (:'o_zero', :'ua', :'p', :'sn_zero', null, 'pending_payment', 8900, null);

select checks18.eq((select count(*) from public.orders where id = :'o_pend' and snapshot_at is null)::int, 1,
  'an unpaid order has no snapshot');

-- The Stripe webhook path (0013).
set role service_role;
select checks18.eq(
  public.stripe_checkout_completed('evt_est18_pair', 'cs_est18_pair', 'pi_est18_pair', 17800, 'usd', '{"name":"A"}'),
  'applied', 'the webhook marks the pair order paid');
reset role;

select checks18.eq(
  (select format('%s/%s/%s', status, snapshot_at is not null, paid_at is not null) from public.orders where id = :'o_pair'),
  'paid/t/t', 'the paid transition took a snapshot');
select checks18.eq((select snapshot_left -> 'values' from public.orders where id = :'o_pair'), checks18.values25(100),
  'left snapshot holds the left scan''s 25 accepted values');
select checks18.eq((select snapshot_right -> 'values' from public.orders where id = :'o_pair'), checks18.values25(200),
  'right snapshot holds the right scan''s 25 accepted values');
select checks18.eq(
  (select format('%s/%s/%s/%s/%s/%s/%s', snapshot_left ->> 'format', snapshot_left ->> 'version',
     snapshot_left ->> 'scan_id', snapshot_left ->> 'measurement_id', snapshot_left ->> 'schema_version',
     snapshot_left ->> 'extraction_version', snapshot_left ->> 'source')
     from public.orders where id = :'o_pair'),
  format('forms.order-leg-snapshot/1/%s/%s/1.1.0/v1/scan', :'sn_l', :'m_l'),
  'left snapshot records its scan, row, versions and source');
select checks18.eq((select snapshot_left ->> 'leg_model_id' from public.orders where id = :'o_pair'), :'lm_l',
  'left snapshot points at the leg model of the same extraction_version');
select checks18.eq((select snapshot_right -> 'leg_model_id' from public.orders where id = :'o_pair'), 'null'::jsonb,
  'right snapshot has a null leg model id when none exists (v2 scans)');
select checks18.eq((select count(*) from public.pipeline_jobs where order_id = :'o_pair' and step = 'generating_cad')::int, 2,
  'CAD jobs were still enqueued alongside the snapshot');

-- Write-once: a newer accepted row and a re-entry to paid change nothing.
insert into public.measurements (scan_id, schema_version, extraction_version, "values", validated)
values (:'sn_l', '1.1.0', 'v2', checks18.values25(900), true);
update public.orders set status = 'in_production' where id = :'o_pair';
update public.orders set status = 'paid' where id = :'o_pair';
select checks18.eq((select snapshot_left -> 'values' from public.orders where id = :'o_pair'), checks18.values25(100),
  'the snapshot is never retaken once filled');
select checks18.eq(public.snapshot_order_measurements(:'o_pair'), false, 'a direct retake is refused too');

-- THE KEY CHECK: payment succeeds and the snapshot stays null whenever
-- nothing accepted is available. Admin mark-paid path (plain status update).
update public.orders set status = 'paid' where id in (:'o_unval', :'o_sup', :'o_bad');
select checks18.eq(
  (select string_agg(format('%s:%s:%s:%s', id, status, snapshot_left is null and snapshot_right is null, snapshot_at is null), ',' order by id)
     from public.orders where id in (:'o_unval', :'o_sup', :'o_bad')),
  format('%s:paid:t:t,%s:paid:t:t,%s:paid:t:t', :'o_unval', :'o_sup', :'o_bad'),
  'paid with no validated row, only superseded rows, or malformed values: payment succeeds, snapshot null');
select checks18.eq((select count(*) from public.pipeline_jobs where order_id in (:'o_unval', :'o_sup', :'o_bad'))::int, 4,
  'those payments still enqueued their CAD jobs');

-- Forced failure inside the snapshot write: the payment must still commit.
create function checks18.boom() returns trigger language plpgsql as $$
begin
  raise exception 'forced snapshot failure';
end;
$$;
create trigger checks18_boom before update of snapshot_left on public.orders
  for each row execute function checks18.boom();
update public.orders set status = 'paid' where id = :'o_fail';
drop trigger checks18_boom on public.orders;
select checks18.eq(
  (select format('%s/%s/%s', status, snapshot_left is null, snapshot_at is null) from public.orders where id = :'o_fail'),
  'paid/t/t', 'an error inside the snapshot leaves it null and the payment commits');
select checks18.eq(
  (select detail ->> 'sqlstate' from public.audit_log where subject_id = :'o_fail' and action = 'order.snapshot_failed'),
  'P0001', 'the swallowed failure is audited with its SQLSTATE only');
select checks18.eq((select count(*) from public.pipeline_jobs where order_id = :'o_fail')::int, 1,
  'the failed-snapshot payment still enqueued its CAD job');

-- Webhook path with nothing accepted: same outcome.
update public.orders set stripe_checkout_session_id = 'cs_est18_sup2', status = 'pending_payment', paid_at = null
  where id = :'o_sup';
delete from public.pipeline_jobs where order_id = :'o_sup';
set role service_role;
select checks18.eq(
  public.stripe_checkout_completed('evt_est18_sup2', 'cs_est18_sup2', 'pi_est18_sup2', 8900, 'usd', null),
  'applied', 'the webhook pays an order whose scan has nothing accepted');
reset role;
select checks18.eq((select snapshot_at is null and status = 'paid' from public.orders where id = :'o_sup'), true,
  'webhook payment with nothing accepted: paid, snapshot null');

-- No measurements row at all: refused by the 0016 CAD trigger, as before
-- 0021 (unchanged); the snapshot itself returns false without raising.
select checks18.expect_error(format('update public.orders set status = %L where id = %L', 'paid', :'o_zero'), '23514');
select checks18.eq(public.snapshot_order_measurements(:'o_zero'), false,
  'snapshot of an order whose scan has no measurements returns false, no error');
select checks18.eq(public.snapshot_order_measurements('18000000-5555-0000-0000-0000000000ff'), false,
  'snapshot of a missing order returns false, no error');
select checks18.eq(public.order_leg_snapshot(null, null), null::jsonb, 'a missing leg snapshots to null');

-- The envelope checks on the columns.
select checks18.expect_error(format('update public.orders set snapshot_left = %L, snapshot_at = now() where id = %L',
  '{"format":"other","version":1}', :'o_unval'), '23514');
select checks18.expect_error(format('update public.orders set snapshot_at = now() where id = %L', :'o_unval'), '23514');
select checks18.eq(true, true, 'snapshot columns refuse a bad envelope and a lone snapshot_at');

-- ---------------------------------------------------------------------------
-- Remakes (0024): created paid, so the insert takes the snapshot.
-- ---------------------------------------------------------------------------
update public.orders set status = 'shipped' where id in (:'o_pair', :'o_unval');
set role service_role;
create temp table rm_pair as
  select * from public.create_order_remake(:'o_pair', 'print_defect', null, 'both', 'admin@example.test');
create temp table rm_unval as
  select * from public.create_order_remake(:'o_unval', 'fit_too_loose', null, 'left', 'admin@example.test');
reset role;
select checks18.eq((select outcome from rm_pair) || '/' || (select outcome from rm_unval), 'created/created',
  'remakes are still created');
select checks18.eq(
  (select r.snapshot_left = o.snapshot_left and r.snapshot_right = o.snapshot_right and r.snapshot_at is not null
     from public.orders r, public.orders o
     where r.id = (select remake_id from rm_pair) and o.id = :'o_pair'), true,
  'a remake copies the original''s leg snapshots, not the newer accepted row');
select checks18.eq(
  (select format('%s/%s', status, snapshot_at is null) from public.orders where id = (select remake_id from rm_unval)),
  'paid/t', 'a remake with nothing accepted is still created paid, snapshot null');
select checks18.eq((select count(*) from public.pipeline_jobs where order_id = (select remake_id from rm_pair))::int, 2,
  'the remake still enqueued its CAD jobs');

-- ---------------------------------------------------------------------------
-- Clients read their own snapshot and cannot write it.
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select checks18.eq((select snapshot_left -> 'values' from public.orders where id = :'o_pair'), checks18.values25(100),
  'the owner can read their own snapshot');
select checks18.eq(checks18.rows_affected(format(
  'update public.orders set snapshot_left = null, snapshot_right = null, snapshot_at = null where id = %L', :'o_pair')), 0,
  'the owner cannot change the snapshot');
select checks18.expect_error(format(
  'insert into public.orders (user_id, product_id, scan_id_left, snapshot_left, snapshot_at) values (%L, %L, %L, %L, now())',
  :'ua', :'p', :'sn_l', '{"format":"forms.order-leg-snapshot","version":1}'), '42501');
select checks18.eq(true, true, 'the owner cannot insert an order carrying a snapshot');
select set_config('request.jwt.claim.sub', :'ub', false);
select checks18.eq((select count(*) from public.orders where id = :'o_pair')::int, 0,
  'another user cannot see the snapshot');
reset role;
select checks18.eq((select snapshot_left -> 'values' from public.orders where id = :'o_pair'), checks18.values25(100),
  'the snapshot is unchanged after the client attempts');

-- ===========================================================================
-- Function hardening and grants
-- ===========================================================================
select checks18.eq(
  (select bool_and(p.prosecdef and exists (
       select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
     from pg_proc p
     where p.oid in ('public.request_scan_refusion(uuid)'::regprocedure,
                     'public.snapshot_order_measurements(uuid)'::regprocedure,
                     'public.orders_snapshot_measurements()'::regprocedure,
                     'public.export_my_data()'::regprocedure)), true,
  'definer functions pin search_path');
select checks18.eq(
  (select bool_and(not p.prosecdef and exists (
       select 1 from unnest(p.proconfig) c where c like 'search_path=%'))
     from pg_proc p
     where p.oid in ('public.accepted_measurement(uuid)'::regprocedure,
                     'public.order_leg_snapshot(uuid, uuid)'::regprocedure)), true,
  'invoker functions are invoker and pin search_path');
select checks18.eq(
  (select bool_or(has_function_privilege(r, f, 'execute'))
     from unnest(array['public', 'anon']) r,
       unnest(array['public.accepted_measurement(uuid)', 'public.export_my_data()',
                    'public.request_scan_refusion(uuid)', 'public.order_leg_snapshot(uuid, uuid)',
                    'public.snapshot_order_measurements(uuid)', 'public.orders_snapshot_measurements()']) f), false,
  'no new function is executable by PUBLIC or anon');
select checks18.eq(
  (select bool_or(has_function_privilege(r, f, 'execute'))
     from unnest(array['authenticated', 'service_role']) r,
       unnest(array['public.order_leg_snapshot(uuid, uuid)', 'public.snapshot_order_measurements(uuid)',
                    'public.orders_snapshot_measurements()']) f), false,
  'the snapshot internals are owner only');
select checks18.eq(
  format('%s/%s', has_function_privilege('authenticated', 'public.request_scan_refusion(uuid)', 'execute'),
                  has_function_privilege('service_role', 'public.request_scan_refusion(uuid)', 'execute')),
  't/f', 'request_scan_refusion is granted to authenticated only');

-- ---------------------------------------------------------------------------
-- Cleanup (later check files reuse the cluster and count rows globally).
-- ---------------------------------------------------------------------------
delete from public.pipeline_jobs
  where scan_id in (select id from public.scans where user_id in (:'ua', :'ub'));
delete from public.audit_log
  where subject_table = 'orders' and subject_id in (select id from public.orders where product_id = :'p');
delete from public.stripe_events where id like 'evt_est18_%';
delete from public.orders where remake_of is not null and product_id = :'p';
delete from public.orders where product_id = :'p';
delete from public.scans where user_id in (:'ua', :'ub');
select checks18.eq(
  (select count(*) from public.leg_models)::int + (select count(*) from public.measurement_quality)::int, 0,
  'no leg models or quality rows outlive their scans');
delete from public.products where id = :'p';
delete from auth.users where id in (:'ua', :'ub');
drop schema checks18 cascade;
