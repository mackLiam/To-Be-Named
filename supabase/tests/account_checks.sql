-- Per-user isolation for guest and member accounts (supabase/README.md
-- "Accounts and sign-in"). A guest is an anonymous auth user, so it goes
-- through exactly the same RLS as a member; these checks write as one user and
-- read as another rather than trusting the policy text. Run after stubs.sql and
-- every migration (run_sql_checks.sh account_checks.sql).

\set ON_ERROR_STOP 1
\set QUIET 1

create schema acct;
grant usage on schema acct to anon, authenticated;

create function acct.eq(p_actual bigint, p_expected bigint, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'check failed: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

create function acct.denied(p_sql text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'check failed: % (statement succeeded)', p_label;
exception when insufficient_privilege then
  raise notice 'ok: %', p_label;
end;
$$;

grant execute on all functions in schema acct to anon, authenticated;

\set guest '33333333-3333-3333-3333-333333333333'
\set member '44444444-4444-4444-4444-444444444444'
\set scan_a 'cccccccc-0000-0000-0000-000000000001'

-- Platform side (service role): two auth users and a product to order.
insert into auth.users (id, is_anonymous) values (:'guest', true), (:'member', false);
insert into public.products (id, name, slug, base_price_cents)
values ('dddddddd-0000-0000-0000-000000000001', 'Guard', 'acct-guard', 8900);

-- The guest scans and uploads with its own session. Ordering needs an account
-- (0012, "orders: members insert pending own"), so its order is refused.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'guest', true);
select set_config('request.jwt.claims', '{"is_anonymous": true}', true);
insert into public.scans (id, user_id, leg, status, mesh_path)
values (:'scan_a', :'guest', 'L', 'uploaded', :'guest' || '/scan.obj');
insert into storage.objects (bucket_id, name) values ('meshes', :'guest' || '/scan.obj');
select acct.denied(
  format('insert into public.orders (user_id, product_id, scan_id_left) values (%L, %L, %L)',
    '33333333-3333-3333-3333-333333333333', 'dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001'),
  'guest cannot place an order');
select acct.eq((select count(*) from public.scans), 1, 'guest sees its own scan');
select acct.eq((select count(*) from storage.objects), 1, 'guest sees its own mesh');
commit;

-- The guest upgrades (same user id, now a member). Clients never insert
-- orders (0017); checkout creates them with the service role.
update auth.users set is_anonymous = false, email = 'guest@example.com' where id = :'guest';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'guest', true);
select set_config('request.jwt.claims', '{"is_anonymous": false}', true);
select acct.denied(
  format('insert into public.orders (user_id, product_id, scan_id_left) values (%L, %L, %L)',
    '33333333-3333-3333-3333-333333333333', 'dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001'),
  'a member cannot insert an order directly either');
commit;
insert into public.orders (user_id, product_id, scan_id_left)
values (:'guest', 'dddddddd-0000-0000-0000-000000000001', :'scan_a');
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'guest', true);
select set_config('request.jwt.claims', '{"is_anonymous": false}', true);
select acct.eq((select count(*) from public.orders), 1, 'upgraded guest sees its own order');
commit;

-- The worker writes a measurement (service role, as in production).
insert into public.measurements (scan_id, schema_version, extraction_version, "values", validated)
values (:'scan_a', '1.0.0', 'test', '{}'::jsonb, true);

-- A different signed-in user sees none of it and cannot write into it.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'member', true);
select set_config('request.jwt.claims', '{"is_anonymous": false}', true);
select acct.eq((select count(*) from public.scans), 0, 'member cannot see the guest scan');
select acct.eq((select count(*) from public.orders), 0, 'member cannot see the guest order');
select acct.eq((select count(*) from public.measurements), 0, 'member cannot see the guest measurements');
select acct.eq((select count(*) from storage.objects), 0, 'member cannot see the guest mesh');
-- Silently matches zero rows under RLS; checked as the guest below.
update public.scans set status = 'failed' where id = :'scan_a';
select acct.denied(
  format('insert into public.scans (user_id, leg) values (%L, %L)', '33333333-3333-3333-3333-333333333333', 'R'),
  'member cannot create a scan owned by the guest');
select acct.denied(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)', 'meshes', '33333333-3333-3333-3333-333333333333/x.obj'),
  'member cannot upload into the guest mesh prefix');
select acct.denied(
  format('insert into public.orders (user_id, product_id, scan_id_left) values (%L, %L, %L)',
    '33333333-3333-3333-3333-333333333333', 'dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000001'),
  'member cannot place an order as the guest');
commit;

-- Signed out (anon key, no session) reads nothing at all.
begin;
set local role anon;
select acct.eq((select count(*) from public.scans), 0, 'signed out sees no scans');
select acct.eq((select count(*) from public.orders), 0, 'signed out sees no orders');
select acct.eq((select count(*) from public.measurements), 0, 'signed out sees no measurements');
commit;

-- Upgrading a guest attaches an email to the same auth user; the id is
-- unchanged, so the same session still owns everything.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'guest', true);
select acct.eq((select count(*) from public.measurements), 1, 'owner sees its validated measurement');
select acct.eq((select count(*) from public.scans where status = 'uploaded'), 1, 'member update did not touch the guest scan');
select acct.eq((select count(*) from public.orders where scan_id_left = 'cccccccc-0000-0000-0000-000000000001'), 1, 'owner order still references its scan');
commit;
