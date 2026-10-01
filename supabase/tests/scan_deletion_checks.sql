-- User-initiated scan deletion (supabase/migrations/0011_scan_deletion.sql).
-- Irreversible for minors' body data, so every refusal path is exercised by
-- calling the RPC as the user, not by reading the function text. Run after
-- stubs.sql and every migration (run_sql_checks.sh).

\set ON_ERROR_STOP 1
\set QUIET 1

create schema del;
grant usage on schema del to anon, authenticated;

create function del.eq(p_actual bigint, p_expected bigint, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'check failed: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

-- Runs p_sql and passes only if it fails with exactly p_state.
create function del.fails(p_sql text, p_state text, p_label text) returns void
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

grant execute on all functions in schema del to anon, authenticated;

\set owner '55555555-5555-5555-5555-555555555555'
\set other '66666666-6666-6666-6666-666666666666'
\set pair 'eeeeeeee-0000-0000-0000-000000000000'
\set left 'eeeeeeee-0000-0000-0000-000000000001'
\set right 'eeeeeeee-0000-0000-0000-000000000002'
\set ordered 'eeeeeeee-0000-0000-0000-000000000003'
\set foreign 'eeeeeeee-0000-0000-0000-000000000004'

insert into auth.users (id) values (:'owner'), (:'other');
insert into public.products (id, name, slug, base_price_cents)
values ('eeeeeeee-1111-0000-0000-000000000000', 'Guard', 'del-guard', 8900);
insert into public.scans (id, user_id, leg, pair_id, status) values
  (:'left', :'owner', 'L', :'pair', 'uploaded'),
  (:'right', :'owner', 'R', :'pair', 'ready'),
  (:'ordered', :'owner', 'L', null, 'ready'),
  (:'foreign', :'other', 'L', null, 'ready');
insert into public.pipeline_jobs (scan_id, step, status) values (:'left', 'measuring', 'pending');
insert into public.orders (user_id, product_id, scan_id_left)
values (:'owner', 'eeeeeeee-1111-0000-0000-000000000000', :'ordered');

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'owner', true);
select del.fails(format('select public.request_scan_deletion(array[%L]::uuid[])', :'foreign'),
  '42501', 'cannot delete another user''s scan');
select del.fails(format('select public.request_scan_deletion(array[%L, %L]::uuid[])', :'left', :'foreign'),
  '42501', 'ownership is checked for every id, not just the first');
select del.fails(format('select public.request_scan_deletion(array[%L]::uuid[])', :'ordered'),
  '23514', 'cannot delete a scan that is on an order');
select del.fails(format('select public.request_scan_deletion(array[%L, %L, %L]::uuid[])', :'left', :'right', :'ordered'),
  '22023', 'more than one session of ids is refused');
select del.fails('select public.request_scan_deletion(array[]::uuid[])',
  '22023', 'an empty id list is refused');
select del.fails('select * from public.get_scans_pending_purge(10)',
  '42501', 'users cannot read the purge batch');
select public.request_scan_deletion(array[:'left', :'right']::uuid[]);
select public.request_scan_deletion(array[:'left', :'right']::uuid[]);
commit;

select del.eq((select count(*) from public.scans where deleted_at is not null), 2,
  'both legs of the pair are marked, and a repeat call is a no-op');
select del.eq((select count(*) from public.scans where id = :'foreign' and deleted_at is null), 1,
  'the refused call left the other user''s scan untouched');
select del.eq((select count(*) from public.pipeline_jobs where scan_id = :'left' and status = 'dead_letter'), 1,
  'queued work for a deleted scan is dead-lettered');
select del.eq((select count(*) from public.get_scans_pending_purge(10)), 2,
  'the purge batch holds exactly the deleted pair');
select del.fails(format(
  'insert into public.orders (user_id, product_id, scan_id_left) values (%L, %L, %L)',
  :'owner', 'eeeeeeee-1111-0000-0000-000000000000', :'left'),
  '23514', 'an order cannot be placed on a deleted scan');

-- A deleted_at stamped directly (allowed by "scans: update own") on an
-- ordered scan must still never reach the purge.
update public.scans set deleted_at = now() where id = :'ordered';
select del.eq((select count(*) from public.get_scans_pending_purge(10) where scan_id = :'ordered'), 0,
  'a scan on an order is never purged');

begin;
set local role anon;
select del.fails(format('select public.request_scan_deletion(array[%L]::uuid[])', :'left'),
  '42501', 'anon cannot call request_scan_deletion');
commit;
