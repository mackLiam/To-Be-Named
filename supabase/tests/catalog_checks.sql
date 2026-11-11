-- Behavioral checks for 0022_catalog_depth.sql and 0023_product_images.sql:
-- products and product_images read policies (only what the shop shows, plus
-- products on the caller's own orders), no client writes, the catalog check
-- constraints, the single-main-image index, and the product-images bucket.
-- Fixtures are written as the superuser; roles are switched only for the
-- privilege checks. Run by run_sql_checks.sh.

\set ON_ERROR_STOP 1
\set QUIET 1

create schema checks22;
grant usage on schema checks22 to anon, authenticated, service_role;

create function checks22.expect_error(p_sql text, p_state text) returns void
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

-- Runs p_sql and returns the affected row count (RLS hides rows silently on
-- update and delete, so "denied" there means zero rows touched).
create function checks22.rows_affected(p_sql text) returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function checks22.eq(p_actual anyelement, p_expected anyelement, p_label text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'check failed: % (expected %, got %)', p_label, p_expected, p_actual;
  end if;
  raise notice 'ok: %', p_label;
end;
$$;

grant execute on all functions in schema checks22 to anon, authenticated, service_role;

\set ua '22000000-0000-0000-0000-00000000000a'
\set ub '22000000-0000-0000-0000-00000000000b'
\set p_avail '22000000-1111-0000-0000-000000000001'
\set p_soon '22000000-1111-0000-0000-000000000002'
\set p_paused '22000000-1111-0000-0000-000000000003'
\set p_arch '22000000-1111-0000-0000-000000000004'
\set p_owned '22000000-1111-0000-0000-000000000005'
\set p_plain '22000000-1111-0000-0000-000000000006'
\set sc1 '22000000-2222-0000-0000-000000000001'
\set o1 '22000000-3333-0000-0000-000000000001'
\set img_a1 '22000000-4444-0000-0000-000000000001'
\set img_a2 '22000000-4444-0000-0000-000000000002'
\set img_p1 '22000000-4444-0000-0000-000000000003'
\set img_o1 '22000000-4444-0000-0000-000000000004'

insert into auth.users (id) values (:'ua'), (:'ub');

-- ---------------------------------------------------------------------------
-- Defaults: a plain insert is coming_soon, custom-only, order 0.
-- ---------------------------------------------------------------------------
insert into public.products (id, name, slug, base_price_cents) values
  (:'p_plain', 'Plain22', 'plain-22', 100);
select checks22.eq(
  (select availability || '/' || array_to_string(sizing_modes, ',') || '/' || display_order
     from public.products where id = :'p_plain'),
  'coming_soon/custom/0', 'new product defaults: coming_soon, custom, order 0');

insert into public.products (id, name, slug, base_price_cents, availability, cad_model, display_order, active) values
  (:'p_avail', 'Avail22', 'avail-22', 8900, 'available', '{"provider":"dry_run"}', 2, true),
  (:'p_soon', 'Soon22', 'soon-22', 8900, 'coming_soon', null, 1, true),
  (:'p_paused', 'Paused22', 'paused-22', 8900, 'paused', '{"provider":"dry_run"}', 3, true),
  (:'p_arch', 'Arch22', 'arch-22', 8900, 'available', '{"provider":"dry_run"}', 4, false),
  (:'p_owned', 'Owned22', 'owned-22', 8900, 'paused', '{"provider":"dry_run"}', 5, true);

insert into public.scans (id, user_id, leg, status) values (:'sc1', :'ua', 'L', 'uploaded');
insert into public.orders (id, user_id, product_id, scan_id_left, status, amount_cents) values
  (:'o1', :'ua', :'p_owned', :'sc1', 'pending_payment', 8900);

-- ---------------------------------------------------------------------------
-- Check constraints.
-- ---------------------------------------------------------------------------
select checks22.expect_error(
  format('update public.products set availability = %L where id = %L', 'sold_out', :'p_soon'), '23514');
select checks22.expect_error(
  format('update public.products set availability = %L where id = %L', 'available', :'p_soon'), '23514');
select checks22.expect_error(
  format('update public.products set cad_model = null where id = %L', :'p_avail'), '23514');
select checks22.expect_error(
  format('insert into public.products (name, slug, base_price_cents, availability) values (%L, %L, 1, %L)',
         'NoCad', 'no-cad-22', 'available'), '23514');
select checks22.expect_error(
  format('update public.products set sizing_modes = %L where id = %L', '{}', :'p_soon'), '23514');
select checks22.expect_error(
  format('update public.products set sizing_modes = %L where id = %L', '{custom,preset_xl}', :'p_soon'), '23514');
select checks22.expect_error(
  format('update public.products set sizing_modes = array[%L, null] where id = %L', 'custom', :'p_soon'), '23514');
select checks22.expect_error(
  format('update public.products set display_order = -1 where id = %L', :'p_soon'), '23514');
update public.products set sizing_modes = '{custom,preset_s,preset_m,preset_l}' where id = :'p_soon';
select checks22.eq(
  (select cardinality(sizing_modes) from public.products where id = :'p_soon'), 4,
  'all four sizing modes accepted');
update public.products set sizing_modes = '{custom}' where id = :'p_soon';

-- ---------------------------------------------------------------------------
-- product_images: shape checks and one main image per product.
-- ---------------------------------------------------------------------------
insert into public.product_images (id, product_id, storage_path, alt_text, sort_order, is_main) values
  (:'img_a1', :'p_avail', :'p_avail' || '/' || :'img_a1' || '.jpg', 'Front view', 0, true),
  (:'img_a2', :'p_avail', :'p_avail' || '/' || :'img_a2' || '.webp', 'Side view', 1, false),
  (:'img_p1', :'p_paused', :'p_paused' || '/' || :'img_p1' || '.png', 'Paused view', 0, true),
  (:'img_o1', :'p_owned', :'p_owned' || '/' || :'img_o1' || '.png', 'Owned view', 0, true);

select checks22.expect_error(
  format('update public.product_images set is_main = true where id = %L', :'img_a2'), '23505');
select checks22.expect_error(
  format('insert into public.product_images (product_id, storage_path, alt_text) values (%L, %L, %L)',
         :'p_avail', :'p_avail' || '/' || :'img_a1' || '.jpg', 'dup path'), '23505');
-- Path under another product's prefix.
select checks22.expect_error(
  format('insert into public.product_images (product_id, storage_path, alt_text) values (%L, %L, %L)',
         :'p_soon', :'p_avail' || '/22000000-4444-0000-0000-0000000000ff.jpg', 'x'), '23514');
-- Client-style filename, traversal, and a non-image extension.
select checks22.expect_error(
  format('insert into public.product_images (product_id, storage_path, alt_text) values (%L, %L, %L)',
         :'p_soon', :'p_soon' || '/holiday photo.jpg', 'x'), '23514');
select checks22.expect_error(
  format('insert into public.product_images (product_id, storage_path, alt_text) values (%L, %L, %L)',
         :'p_soon', :'p_soon' || '/../22000000-4444-0000-0000-0000000000ff.jpg', 'x'), '23514');
select checks22.expect_error(
  format('insert into public.product_images (product_id, storage_path, alt_text) values (%L, %L, %L)',
         :'p_soon', :'p_soon' || '/22000000-4444-0000-0000-0000000000ff.svg', 'x'), '23514');
select checks22.expect_error(
  format('insert into public.product_images (product_id, storage_path, alt_text) values (%L, %L, %L)',
         :'p_soon', :'p_soon' || '/22000000-4444-0000-0000-0000000000fe.jpg', '   '), '23514');
select checks22.expect_error(
  format('insert into public.product_images (product_id, storage_path, alt_text) values (%L, %L, %L)',
         :'p_soon', :'p_soon' || '/22000000-4444-0000-0000-0000000000fd.jpg', repeat('a', 201)), '23514');
-- A second main is fine on another product, and moving main is unset-then-set.
update public.product_images set is_main = false where id = :'img_a1';
update public.product_images set is_main = true where id = :'img_a2';
select checks22.eq(
  (select count(*) from public.product_images where product_id = :'p_avail' and is_main)::int, 1,
  'main image moved within one product');

-- ---------------------------------------------------------------------------
-- Storage bucket.
-- ---------------------------------------------------------------------------
select checks22.eq(
  (select public::text || '/' || file_size_limit || '/' || array_to_string(allowed_mime_types, ',')
     from storage.buckets where id = 'product-images'),
  'true/4194304/image/jpeg,image/png,image/webp', 'product-images bucket is public, 4 MB, jpeg/png/webp');
select checks22.eq(
  (select bool_or(public) from storage.buckets where id in ('meshes', 'stls')), false,
  'scan and STL buckets stay private');
insert into storage.objects (bucket_id, name) values
  ('product-images', :'p_avail' || '/' || :'img_a1' || '.jpg'),
  ('meshes', :'ua' || '/scan.obj');

-- ---------------------------------------------------------------------------
-- anon: reads only what the shop shows; no writes anywhere.
-- ---------------------------------------------------------------------------
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select checks22.eq(
  (select string_agg(name, ',' order by display_order) from public.products where slug like '%-22'),
  'Plain22,Soon22,Avail22', 'anon sees available and coming_soon, not paused or archived');
select checks22.eq(
  (select string_agg(alt_text, ',' order by sort_order) from public.product_images),
  'Front view,Side view', 'anon sees only images of shop-visible products');
select checks22.expect_error('select cad_model from public.products', '42501');
select checks22.eq(
  (select availability || '/' || array_to_string(sizing_modes, ',') from public.products where id = :'p_avail'),
  'available/custom', 'anon can read the new catalog columns');
select checks22.expect_error(
  'insert into public.products (name, slug, base_price_cents) values (''x'', ''anon-22'', 1)', '42501');
select checks22.eq(
  checks22.rows_affected(format('update public.products set base_price_cents = 1 where id = %L', :'p_avail')), 0,
  'anon cannot update products');
select checks22.eq(
  checks22.rows_affected(format('delete from public.products where id = %L', :'p_plain')), 0,
  'anon cannot delete products');
select checks22.expect_error(
  format('insert into public.product_images (product_id, storage_path, alt_text) values (%L, %L, %L)',
         :'p_avail', :'p_avail' || '/22000000-4444-0000-0000-0000000000aa.jpg', 'x'), '42501');
select checks22.expect_error(
  format('update public.product_images set alt_text = %L where id = %L', 'x', :'img_a1'), '42501');
select checks22.expect_error(
  format('delete from public.product_images where id = %L', :'img_a1'), '42501');
select checks22.eq(
  (select count(*) from storage.objects where bucket_id = 'product-images')::int, 0,
  'anon cannot list product-images objects (public URLs need no policy)');
select checks22.eq(
  (select count(*) from storage.objects where bucket_id = 'meshes')::int, 0,
  'anon still cannot read meshes');
select checks22.expect_error(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)',
         'product-images', :'p_avail' || '/22000000-4444-0000-0000-0000000000ab.jpg'), '42501');
select checks22.eq(
  checks22.rows_affected('delete from storage.objects where bucket_id = ''product-images'''), 0,
  'anon cannot delete product-images objects');
select checks22.eq(public.is_product_on_my_order(:'p_owned'), false, 'anon owns no orders');
reset role;

-- ---------------------------------------------------------------------------
-- authenticated: the shop, plus products on the caller's own orders.
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claim.sub', :'ua', false);
select checks22.eq(
  (select string_agg(name, ',' order by display_order) from public.products where slug like '%-22'),
  'Plain22,Soon22,Avail22,Owned22', 'owner also sees the paused product on their order');
select checks22.eq(
  (select count(*) from public.product_images where product_id = :'p_owned')::int, 0,
  'images of a paused product stay hidden even from its buyer');
select checks22.expect_error(
  'insert into public.products (name, slug, base_price_cents) values (''x'', ''auth-22'', 1)', '42501');
select checks22.eq(
  checks22.rows_affected(format('update public.products set availability = %L where id = %L', 'paused', :'p_avail')), 0,
  'authenticated cannot update products');
select checks22.eq(
  checks22.rows_affected(format('delete from public.products where id = %L', :'p_plain')), 0,
  'authenticated cannot delete products');
select checks22.expect_error(
  format('insert into public.product_images (product_id, storage_path, alt_text) values (%L, %L, %L)',
         :'p_avail', :'p_avail' || '/22000000-4444-0000-0000-0000000000ac.jpg', 'x'), '42501');
select checks22.expect_error(
  format('update public.product_images set is_main = false where id = %L', :'img_a2'), '42501');
select checks22.expect_error(
  format('delete from public.product_images where id = %L', :'img_a1'), '42501');
select checks22.expect_error(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)',
         'product-images', :'p_avail' || '/22000000-4444-0000-0000-0000000000ad.jpg'), '42501');
select checks22.eq(
  checks22.rows_affected('update storage.objects set name = ''x'' where bucket_id = ''product-images'''), 0,
  'authenticated cannot rename product-images objects');

select set_config('request.jwt.claim.sub', :'ub', false);
select checks22.eq(
  (select string_agg(name, ',' order by display_order) from public.products where slug like '%-22'),
  'Plain22,Soon22,Avail22', 'another user does not see the paused product');
select checks22.eq(public.is_product_on_my_order(:'p_owned'), false, 'helper answers only for the caller');
reset role;

select checks22.eq(
  (select bool_or(has_function_privilege(r, 'public.is_product_on_my_order(uuid)', 'execute'))
     from unnest(array['public']) r), false, 'helper not executable by PUBLIC');

-- ---------------------------------------------------------------------------
-- Cleanup (later check files reuse the cluster). Images cascade.
-- ---------------------------------------------------------------------------
delete from storage.objects where name like '22000000-%';
delete from public.orders where id = :'o1';
delete from public.scans where id = :'sc1';
delete from public.products where slug like '%-22';
select checks22.eq(
  (select count(*) from public.product_images where id in (:'img_a1', :'img_a2', :'img_p1', :'img_o1'))::int, 0,
  'deleting a product cascades to its images');
delete from auth.users where id in (:'ua', :'ub');
drop schema checks22 cascade;
