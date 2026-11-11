-- 0022_catalog_depth.sql
-- Catalog depth for the admin panel: shop order, availability states, and
-- the sizing modes each product sells. docs/DESIGN.md 7a (product line),
-- docs/BUSINESS-GAPS.md ranks 7, 10 and 13.
--
-- Meanings (kept deliberately separate):
--   - active: archived or not (0001). Unchanged. false = archived, hidden from
--     the shop, kept for order history.
--   - availability: the shop state of a non-archived product.
--       available    listed and purchasable
--       coming_soon  listed, not purchasable
--       paused       hidden from the shop (for example a long print queue)
--   - sizing_modes: DESIGN.md 7a.3. Each product row is one guard model tier
--     (7a.1 Pro / Club / Junior Max; 7a.2 "adding a model = inserting a
--     product row"), so the model tier is the row itself, not a column. What
--     varies inside a tier is the sizing mode: custom (from a scan) or a
--     standard preset S, M, L. Preset value sets do not exist yet, so
--     checkout (scan based) sells custom only.
--   - display_order: ascending shop order; ties break by name.
--
-- Purchasable also needs a cad_model: the paid trigger (0016
-- enqueue_cad_jobs_for_order) refuses a product without one, so a product
-- sold without it would take money it cannot fulfil. Enforced here as a
-- constraint, so no write path (admin, SQL editor, future tooling) can skip
-- it.
--
-- Exercised by supabase/tests/catalog_checks.sql.

alter table public.products
  add column display_order integer not null default 0
    constraint products_display_order_range check (display_order between 0 and 100000),
  -- New rows default to coming_soon: making a product purchasable is an
  -- explicit release step (DESIGN.md 7a.4), never a side effect of an insert.
  add column availability text not null default 'coming_soon'
    constraint products_availability_check
      check (availability in ('available', 'coming_soon', 'paused')),
  -- Array containment rejects unknown values and nulls (null never equals).
  add column sizing_modes text[] not null default array['custom']::text[]
    constraint products_sizing_modes_check
      check (
        cardinality(sizing_modes) between 1 and 4
        and sizing_modes <@ array['custom', 'preset_s', 'preset_m', 'preset_l']::text[]
      );

comment on column public.products.display_order is
  'Ascending shop order (ties by name). Set from the admin products list.';
comment on column public.products.availability is
  'Shop state of a non-archived product: available (purchasable), coming_soon (listed, not purchasable), paused (hidden). active=false still means archived.';
comment on column public.products.sizing_modes is
  'Sizing modes this product sells (DESIGN.md 7a.3): custom, preset_s, preset_m, preset_l. Checkout sells custom only until preset value sets exist.';

-- Existing rows keep selling exactly when they could be fulfilled: a product
-- with a CAD model stays purchasable, one without becomes coming_soon
-- (it was already unpayable: the paid trigger refuses it).
update public.products
  set availability = case when cad_model is not null then 'available' else 'coming_soon' end;

alter table public.products
  add constraint products_available_needs_cad_model
  check (availability <> 'available' or cad_model is not null);

create index products_shop_order_idx on public.products(display_order, name);

-- Column grant (0013 H) extended to the new columns; cad_model stays hidden.
grant select (display_order, availability, sizing_modes) on public.products to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Read policy: clients see what the shop shows (not archived, not paused),
-- plus any product on one of their own orders, so order history keeps its
-- product name after a product is archived or paused. Replaces 0002
-- "products: select all". Writes stay service-role only (no write policies).
-- ---------------------------------------------------------------------------

-- Definer so the products policy does not depend on the caller's privileges
-- on orders (anon has no orders policy at all). Answers only for auth.uid(),
-- so it reveals nothing about other users.
create function public.is_product_on_my_order(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.orders o
    where o.product_id = p_product_id
      and o.user_id = auth.uid()
  );
$$;

revoke execute on function public.is_product_on_my_order(uuid) from public;
grant execute on function public.is_product_on_my_order(uuid) to anon, authenticated, service_role;

drop policy "products: select all" on public.products;

create policy "products: select shop visible or own order"
on public.products for select
to anon, authenticated
using (
  (active and availability <> 'paused')
  or public.is_product_on_my_order(id)
);
