-- 0016: a reorder of the same guard from the same scan, paid while the first
-- order's CAD job is still active, gets its own job.

\set ON_ERROR_STOP 1
\set QUIET 1

create schema checks16;

create function checks16.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'check failed: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

\set u '16000000-0000-0000-0000-000000000001'
\set s '16000000-0000-0000-0000-0000000000a1'
\set p '16000000-0000-0000-0000-0000000000b1'
\set o1 '16000000-0000-0000-0000-0000000000c1'
\set o2 '16000000-0000-0000-0000-0000000000c2'

insert into auth.users (id) values (:'u');
insert into public.scans (id, user_id, leg, status, mesh_path)
  values (:'s', :'u', 'L', 'ready', :'u' || '/' || :'s' || '.obj');
insert into public.measurements (scan_id, schema_version, extraction_version, "values", validated)
  values (:'s', '1.0.0', 'x', '{}', true);
insert into public.products (id, name, slug, base_price_cents, active, cad_model)
  values (:'p', 'p16', 'p16', 100, true, '{"provider":"dry_run"}');

insert into public.orders (id, user_id, product_id, scan_id_left, status) values (:'o1', :'u', :'p', :'s', 'paid');
insert into public.orders (id, user_id, product_id, scan_id_left, status) values (:'o2', :'u', :'p', :'s', 'paid');

select checks16.eq(
  (select count(*) from public.pipeline_jobs where order_id = :'o1' and status = 'pending')::int, 1,
  'first order has its CAD job');
select checks16.eq(
  (select count(*) from public.pipeline_jobs where order_id = :'o2' and status = 'pending')::int, 1,
  'reorder of the same guard and scan gets its own CAD job');

-- Replaying the paid transition on the same order is still absorbed.
update public.orders set status = 'paid' where id = :'o2';
select checks16.eq(
  (select count(*) from public.pipeline_jobs where order_id = :'o2')::int, 1,
  'repeat paid transition does not duplicate the order''s job');

select checks16.eq(
  (select array_agg(j order by j) from public.enqueue_cad_jobs_for_order(:'o2') j)
    = (select array_agg(id order by id) from public.pipeline_jobs where order_id = :'o2'), true,
  'enqueue returns the order''s own active job');

-- checks.sql runs after this file and counts CAD jobs globally: leave nothing.
delete from public.pipeline_jobs where order_id in (:'o1', :'o2');
delete from public.orders where id in (:'o1', :'o2');
delete from public.scans where id = :'s';
delete from public.products where id = :'p';
delete from auth.users where id = :'u';
