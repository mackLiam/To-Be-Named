-- Behavioral checks for 0014_manual_measurements.sql: capture_kind 'manual',
-- measurements.source, submit_manual_measurements refusals and job shape, and
-- scans.status across manual jobs (0013 E). Run by run_sql_checks.sh against
-- the same database as every other *checks.sql, so ids are unique to this
-- file and deleted fixtures are removed at the end.

\set ON_ERROR_STOP 1
\set QUIET 1

create schema checks14;
grant usage on schema checks14 to anon, authenticated, service_role;

create function checks14.expect_error(p_sql text, p_state text) returns void
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

create function checks14.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'check failed: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

grant execute on all functions in schema checks14 to anon, authenticated, service_role;

\set ua '14000000-0000-0000-0000-00000000000a'
\set ub '14000000-0000-0000-0000-00000000000b'
\set sman '14000000-2222-0000-0000-000000000001'
\set smesh '14000000-2222-0000-0000-000000000002'
\set sdel '14000000-2222-0000-0000-000000000003'
\set scap '14000000-2222-0000-0000-000000000004'
\set vals '{"Leg_Length": 400, "S1_ISW": 61.5}'

insert into auth.users (id) values (:'ua'), (:'ub');
insert into public.scans (id, user_id, leg, status) values
  (:'smesh', :'ua', 'R', 'uploaded'),
  (:'sdel', :'ua', 'L', 'uploaded'),
  (:'scap', :'ua', 'L', 'capturing');
update public.scans set deleted_at = now() where id = :'sdel';

-- ---------------------------------------------------------------------------
-- Columns and constraints
-- ---------------------------------------------------------------------------
select checks14.expect_error(format(
  'insert into public.scans (id, user_id, leg, status, capture_kind) values (%L, %L, ''L'', ''uploaded'', ''laser'')',
  '14000000-2222-0000-0000-0000000000ff', :'ua'), '23514');
insert into public.measurements (scan_id, schema_version, extraction_version, "values")
  values (:'smesh', '1.0.0', 'checks14', '{}');
select checks14.eq((select source from public.measurements where scan_id = :'smesh'), 'scan',
  'measurements.source defaults to scan');
select checks14.expect_error(format(
  'insert into public.measurements (scan_id, schema_version, extraction_version, "values", source) values (%L, ''1.0.0'', ''x'', ''{}'', ''guess'')',
  :'smesh'), '23514');

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
select checks14.eq(has_function_privilege('anon', 'public.submit_manual_measurements(uuid, jsonb)', 'execute'),
  false, 'anon cannot execute submit_manual_measurements');
select checks14.eq(has_function_privilege('authenticated', 'public.submit_manual_measurements(uuid, jsonb)', 'execute'),
  true, 'authenticated can execute submit_manual_measurements');
select checks14.eq(has_function_privilege('service_role', 'public.submit_manual_measurements(uuid, jsonb)', 'execute'),
  true, 'service_role can execute submit_manual_measurements');

-- ---------------------------------------------------------------------------
-- The client creates the manual scan itself (contract: capture_kind manual,
-- mesh_path null, status uploaded), then calls the RPC.
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
insert into public.scans (id, user_id, leg, status, capture_kind) values (:'sman', :'ua', 'L', 'uploaded', 'manual');

-- Refusals that never insert a job.
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'sman', '[1, 2]'), '22023');
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'sman', '"400"'), '22023');
select checks14.expect_error(format('select public.submit_manual_measurements(%L, null)', :'sman'), '22023');
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'sman', '{"Leg_Length": "400"}'), '22023');
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'sman', '{"Leg_Length": null}'), '22023');
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'sman', '{"Leg_Length": {"mm": 400}}'), '22023');
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'sman',
  (select jsonb_object_agg('k' || i, 100) from generate_series(1, 600) i)::text), '22023');
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'sdel', :'vals'), '23514');
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'scap', :'vals'), '23514');
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)',
  '14000000-2222-0000-0000-0000000000ee', :'vals'), 'P0002');

select set_config('request.jwt.claim.sub', :'ub', false);
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'sman', :'vals'), '42501');
select set_config('request.jwt.claim.sub', '', false);
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'sman', :'vals'), '42501');
set role anon;
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'sman', :'vals'), '42501');
reset role;

select checks14.eq((select count(*) from public.pipeline_jobs where scan_id in (:'sman', :'sdel', :'scap'))::int, 0,
  'refused calls inserted no job');
select checks14.eq((select status from public.scans where id = :'sman'), 'uploaded', 'refused calls left the scan uploaded');

-- ---------------------------------------------------------------------------
-- Owner ok: job shape, then status transitions on a manual scan.
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select public.submit_manual_measurements(:'sman', :'vals') as jm1 \gset
select checks14.eq((select status from public.scans where id = :'sman'), 'processing',
  'E: manual job on an uploaded manual scan -> processing');
select checks14.expect_error(format('select public.submit_manual_measurements(%L, %L)', :'sman', :'vals'), '55P03');
-- The other enqueue path is blocked by the same active job.
select checks14.eq(public.enqueue_measure_job(:'sman'), :'jm1'::uuid, 'enqueue_measure_job returns the active manual job');
reset role;

select checks14.eq(
  (select step || '/' || status || '/' || coalesce(product_id::text, '-') || '/' || coalesce(order_id::text, '-')
     from public.pipeline_jobs where id = :'jm1'),
  'measuring/pending/-/-', 'job row: measuring, pending, no product, no order');
select checks14.eq((select artifacts from public.pipeline_jobs where id = :'jm1'),
  jsonb_build_object('source', 'manual', 'values', :'vals'::jsonb), 'job artifacts carry source and values verbatim');
select checks14.eq((select count(*) from public.pipeline_jobs where scan_id = :'sman')::int, 1,
  'the 55P03 conflict inserted no second job');

-- Dead letter (worker gates rejected the values) -> failed at measuring.
select public.fail_pipeline_job(:'jm1', '{"reason":"out of range"}', false) \g /dev/null
select checks14.eq((select status || '/' || failed_step from public.scans where id = :'sman'), 'failed/measuring',
  'E: dead-lettered manual job -> failed/measuring');

-- Enter again after a failure: processing, then ready on success.
set role authenticated;
select public.submit_manual_measurements(:'sman', :'vals') as jm2 \gset
reset role;
select checks14.eq((select status || '/' || coalesce(failed_step, '-') from public.scans where id = :'sman'), 'processing/-',
  'E: re-entry after failed -> processing, failed_step cleared');
select public.complete_pipeline_job(:'jm2', 'measured') \g /dev/null
select checks14.eq((select status from public.scans where id = :'sman'), 'ready', 'E: succeeded manual job -> ready');

-- Adjust after success: ready -> processing -> ready.
set role authenticated;
select public.submit_manual_measurements(:'sman', '{"Leg_Length": 401}') as jm3 \gset
reset role;
select checks14.eq((select status from public.scans where id = :'sman'), 'processing', 'E: adjustment on a ready scan -> processing');
select public.complete_pipeline_job(:'jm3', 'measured') \g /dev/null
select checks14.eq((select status from public.scans where id = :'sman'), 'ready', 'E: adjustment succeeded -> ready');

-- A mesh scan can be adjusted too; capture_kind is unchanged by the RPC.
set role authenticated;
select public.submit_manual_measurements(:'smesh', :'vals') \g /dev/null
reset role;
select checks14.eq((select capture_kind || '/' || status from public.scans where id = :'smesh'), 'mesh/processing',
  'adjusting a mesh scan keeps capture_kind mesh');

-- Deleted fixtures are frozen (0012) and counted globally by later files.
delete from public.scans where id = :'sdel';
