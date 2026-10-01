-- Behavioral checks for 0007/0008 RPCs and queue helpers. Run by
-- run_sql_checks.sh after stubs.sql and every migration; any failed check
-- raises, and ON_ERROR_STOP turns that into a non-zero exit.

\set ON_ERROR_STOP 1
\set QUIET 1

create schema checks;
grant usage on schema checks to anon, authenticated, service_role;

create function checks.expect_error(p_sql text, p_state text) returns void
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

create function checks.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'check failed: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

grant execute on all functions in schema checks to anon, authenticated, service_role;

\set u1 '11111111-1111-1111-1111-111111111111'
\set u2 '22222222-2222-2222-2222-222222222222'
\set s_mesh 'aaaaaaaa-0000-0000-0000-000000000001'
\set s_photo 'aaaaaaaa-0000-0000-0000-000000000002'
\set s_both 'aaaaaaaa-0000-0000-0000-000000000003'
\set p_ok 'bbbbbbbb-0000-0000-0000-000000000001'
\set p_off 'bbbbbbbb-0000-0000-0000-000000000002'
\set p_nomodel 'bbbbbbbb-0000-0000-0000-000000000003'
\set p_ok2 'bbbbbbbb-0000-0000-0000-000000000004'
\set p_missing 'bbbbbbbb-0000-0000-0000-0000000000ff'

-- Fixtures (as the superuser, i.e. service role equivalent).
insert into auth.users (id) values (:'u1'), (:'u2');
insert into public.scans (id, user_id, leg, status, mesh_path) values
  (:'s_mesh', :'u1', 'L', 'uploaded', :'u1' || '/' || :'s_mesh' || '.obj'),
  (:'s_both', :'u1', 'R', 'uploaded', :'u1' || '/' || :'s_both' || '.obj');
insert into public.scans (id, user_id, leg, status, capture_kind) values
  (:'s_photo', :'u1', 'L', 'uploaded', 'photos');
insert into public.products (id, name, slug, base_price_cents, active, cad_model) values
  (:'p_ok', 'ok', 'ok', 100, true, '{"provider":"dry_run"}'),
  (:'p_off', 'off', 'off', 100, false, '{"provider":"dry_run"}'),
  (:'p_nomodel', 'nomodel', 'nomodel', 100, true, null),
  (:'p_ok2', 'ok2', 'ok2', 100, true, '{"provider":"dry_run"}');

select checks.eq((select capture_kind from public.scans where id = :'s_mesh'), 'mesh', 'capture_kind defaults to mesh');
select checks.expect_error(
  format('update public.scans set capture_kind = %L where id = %L', 'video', :'s_mesh'), '23514');

-- ---------------------------------------------------------------------------
-- enqueue_measure_job
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'u1', false);

select public.enqueue_measure_job(:'s_mesh') as mesh_job \gset
select public.enqueue_measure_job(:'s_photo') as photo_job \gset
select checks.eq(public.enqueue_measure_job(:'s_mesh'), :'mesh_job'::uuid, 'enqueue is idempotent (same active job id)');

select set_config('request.jwt.claim.sub', :'u2', false);
select checks.expect_error(format('select public.enqueue_measure_job(%L)', :'s_mesh'), '42501');
select set_config('request.jwt.claim.sub', '', false);
select checks.expect_error(format('select public.enqueue_measure_job(%L)', :'s_mesh'), '42501');

-- Queue helpers are service-role only, including against Supabase's
-- default EXECUTE grants to authenticated/anon.
select checks.expect_error(format('select * from public.claim_pipeline_job(%L, %L::text[])', 'w', '{measuring}'), '42501');
select checks.expect_error(format('select public.complete_pipeline_job(%L, %L)', :'mesh_job', 'measured'), '42501');
select checks.expect_error(format('select public.advance_pipeline_job(%L, %L)', :'mesh_job', 'measured'), '42501');
select checks.expect_error(format('select public.fail_pipeline_job(%L, %L)', :'mesh_job', '{}'), '42501');
select checks.expect_error('select * from public.get_meshes_pending_deletion()', '42501');
set role anon;
select checks.expect_error(format('select * from public.claim_pipeline_job(%L, %L::text[])', 'w', '{measuring}'), '42501');
select checks.expect_error(format('select public.enqueue_measure_job(%L)', :'s_mesh'), '42501');
select checks.expect_error(format('select * from public.enqueue_cad_jobs_for_order(%L)', :'s_mesh'), '42501');
reset role;

select checks.eq((select step from public.pipeline_jobs where id = :'mesh_job'), 'measuring', 'mesh scan starts at measuring');
select checks.eq((select step from public.pipeline_jobs where id = :'photo_job'), 'reconstructing', 'photos scan starts at reconstructing');

-- ---------------------------------------------------------------------------
-- claim_pipeline_job(worker, steps, limit) as service_role
-- ---------------------------------------------------------------------------
set role service_role;
select checks.expect_error('select * from public.claim_pipeline_job(''w'', null)', '22023');
select checks.expect_error('select * from public.claim_pipeline_job(''w'', ''{}''::text[])', '22023');

select checks.eq(
  (select array_agg(id) from public.claim_pipeline_job('w-measure', array['measuring'], 10)),
  array[:'mesh_job'::uuid],
  'claim filters by step: measuring worker gets only the mesh job');
select checks.eq(
  (select status from public.pipeline_jobs where id = :'photo_job'), 'pending',
  'reconstructing job left pending for a reconstruct worker');
select checks.eq(
  (select array_agg(id) from public.claim_pipeline_job('w-mac', array['reconstructing', 'measuring'], 10)),
  array[:'photo_job'::uuid],
  'claim with several steps; running job is not re-claimed');

-- ---------------------------------------------------------------------------
-- complete_pipeline_job(id, step, artifacts)
-- ---------------------------------------------------------------------------
select public.advance_pipeline_job(:'photo_job', 'measuring', '{"mesh_path":"x"}') \g /dev/null
select public.complete_pipeline_job(:'photo_job', 'measured', '{"needs_scale_confirmation":false}') \g /dev/null
select checks.eq(
  (select step || '/' || status from public.pipeline_jobs where id = :'photo_job'), 'measured/succeeded',
  'complete sets step and succeeded atomically');
select checks.eq(
  (select artifacts from public.pipeline_jobs where id = :'photo_job'),
  '{"mesh_path":"x","needs_scale_confirmation":false}'::jsonb,
  'complete merges artifacts');
select checks.eq(
  (select count(*) from public.claim_pipeline_job('w-any', array['measured'], 10))::int, 0,
  'completed measured job is never claimable');
reset role;

-- ---------------------------------------------------------------------------
-- CAD on purchase (orders_enqueue_cad trigger)
-- ---------------------------------------------------------------------------
insert into public.measurements (scan_id, schema_version, extraction_version, "values")
values (:'s_mesh', '1.0.0', 'test', '{}'), (:'s_both', '1.0.0', 'test', '{}');

-- Clients cannot start CAD directly.
set role authenticated;
select set_config('request.jwt.claim.sub', :'u1', false);
select checks.expect_error(format('select public.enqueue_cad_jobs_for_order(%L)', :'p_missing'), '42501');
reset role;

-- An unpaid order enqueues nothing.
insert into public.orders (id, user_id, product_id, scan_id_left, scan_id_right, status) values
  ('cccccccc-0000-0000-0000-000000000001', :'u1', :'p_ok', :'s_mesh', :'s_both', 'pending_payment');
select checks.eq(
  (select count(*) from public.pipeline_jobs where product_id is not null)::int, 0,
  'unpaid order enqueues no CAD job');

-- Paying enqueues one CAD job per scan, carrying product and order.
update public.orders set status = 'paid' where id = 'cccccccc-0000-0000-0000-000000000001';
select checks.eq(
  (select count(*) from public.pipeline_jobs
     where order_id = 'cccccccc-0000-0000-0000-000000000001'
       and product_id = :'p_ok' and step = 'generating_cad' and status = 'pending')::int, 2,
  'paid order enqueues a CAD job per scan');
select id as cad_job from public.pipeline_jobs
  where scan_id = :'s_both' and product_id = :'p_ok' \gset

-- Re-firing (status touched again) is idempotent.
update public.orders set status = 'paid' where id = 'cccccccc-0000-0000-0000-000000000001';
select checks.eq(
  (select count(*) from public.pipeline_jobs where product_id = :'p_ok')::int, 2,
  'repeat paid transition does not duplicate CAD jobs');

-- Measure job and CAD job active together on one scan.
set role authenticated;
select set_config('request.jwt.claim.sub', :'u1', false);
select public.enqueue_measure_job(:'s_both') as both_measure \gset
reset role;
select checks.eq(
  (select count(*) from public.pipeline_jobs where scan_id = :'s_both' and status in ('pending', 'running'))::int, 2,
  'measure + CAD job both active on one scan');
select checks.eq(
  (select product_id from public.pipeline_jobs where id = :'both_measure'), null::uuid,
  'measure job has no product_id');
select checks.expect_error(
  format('insert into public.pipeline_jobs (scan_id, step) values (%L, %L)', :'s_both', 'measuring'), '23505');
select checks.expect_error(
  format('insert into public.pipeline_jobs (scan_id, product_id, step) values (%L, %L, %L)', :'s_both', :'p_ok', 'generating_cad'), '23505');

-- A second template bought for the same scan gets its own job.
insert into public.orders (user_id, product_id, scan_id_left, status) values
  (:'u1', :'p_ok2', :'s_mesh', 'paid');
select checks.eq(
  (select count(*) from public.pipeline_jobs where scan_id = :'s_mesh' and product_id = :'p_ok2')::int, 1,
  'order inserted as paid enqueues CAD for a second template');

-- After the CAD job completes, a new paid order creates a fresh job.
select public.complete_pipeline_job(:'cad_job', 'stl_ready', '{"stl_path":"p"}') \g /dev/null
insert into public.orders (user_id, product_id, scan_id_right, status) values
  (:'u1', :'p_ok', :'s_both', 'paid');
select checks.eq(
  (select count(*) from public.pipeline_jobs where scan_id = :'s_both' and product_id = :'p_ok' and status = 'pending')::int, 1,
  'paid order after completion creates a new CAD job');

-- Refusals: unmeasured scan and template without a CAD model block payment.
select checks.expect_error(
  format('insert into public.orders (user_id, product_id, scan_id_left, status) values (%L, %L, %L, %L)', :'u1', :'p_ok', :'s_photo', 'paid'), '23514');
select checks.expect_error(
  format('insert into public.orders (user_id, product_id, scan_id_left, status) values (%L, %L, %L, %L)', :'u1', :'p_nomodel', :'s_mesh', 'paid'), '23514');

-- ---------------------------------------------------------------------------
-- storage.objects policies on meshes
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'u1', false);
insert into storage.objects (bucket_id, name) values ('meshes', :'u1' || '/' || :'s_photo' || '/capture.json');
select checks.expect_error(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'meshes', :'u2' || '/x.jpg'), '42501');

with u as (
  update storage.objects set owner = :'u1'
  where name = :'u1' || '/' || :'s_photo' || '/capture.json' returning 1
) select checks.eq((select count(*) from u)::int, 1, 'owner can update (upsert) own object');
select checks.expect_error(
  format('update storage.objects set name = %L where name = %L', :'u2' || '/stolen.json', :'u1' || '/' || :'s_photo' || '/capture.json'),
  '42501');
with d as (delete from storage.objects where bucket_id = 'meshes' returning 1)
select checks.eq((select count(*) from d)::int, 0, 'client delete removes nothing (no delete policy)');

select set_config('request.jwt.claim.sub', :'u2', false);
with u as (update storage.objects set owner = :'u2' where bucket_id = 'meshes' returning 1)
select checks.eq((select count(*) from u)::int, 0, 'other user cannot update foreign object');
reset role;

