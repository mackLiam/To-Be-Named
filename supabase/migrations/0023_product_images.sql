-- 0023_product_images.sql
-- Product photos: an ordered gallery per product with one main image, stored
-- in a PUBLIC bucket. Public is deliberate and limited to catalog photos:
-- scans, meshes and STLs stay in the private buckets of 0003 with signed URLs
-- (DESIGN.md section 9). Nothing in this migration touches those.
--
-- Writes are service-role only: the admin panel validates every upload
-- server-side (type by magic bytes, 4 MB, at most 6000 px per side) and
-- builds the storage path itself (<product_id>/<uuid>.<ext>), never from a
-- client filename (apps/web/src/lib/product-images.ts).
--
-- products.image_url (0009) is kept: the shop falls back to it while
-- products have no uploaded main image.
--
-- Exercised by supabase/tests/catalog_checks.sql.

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_path text not null unique,
  alt_text text not null,
  sort_order integer not null default 0,
  is_main boolean not null default false,
  created_at timestamptz not null default now(),
  -- Same shape the admin upload generates; anything else is not ours.
  constraint product_images_path_shape check (
    storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'
    and split_part(storage_path, '/', 1) = product_id::text
  ),
  -- Alt text is required for accessibility; 200 matches the admin form.
  constraint product_images_alt_text_length
    check (char_length(btrim(alt_text)) between 1 and 200),
  constraint product_images_sort_order_range check (sort_order between 0 and 10000)
);

comment on table public.product_images is
  'Catalog photos (public bucket product-images). One main image per product (partial unique index). Writes via the admin panel only.';

-- At most one main image per product.
create unique index product_images_one_main_idx
  on public.product_images(product_id) where is_main;

create index product_images_product_order_idx
  on public.product_images(product_id, sort_order, created_at);

alter table public.product_images enable row level security;

-- Supabase default privileges grant everything to the client roles; reduce
-- to read only. RLS below then limits which rows.
revoke all on public.product_images from anon, authenticated;
grant select on public.product_images to anon, authenticated;

-- Mirrors the products read policy (0022): images of products the shop
-- shows. Evaluated under the caller's products policy, so an image is never
-- visible when its product is not.
create policy "product_images: select shop visible"
on public.product_images for select
to anon, authenticated
using (
  exists (
    select 1 from public.products p
    where p.id = product_images.product_id
      and p.active
      and p.availability <> 'paused'
  )
);

-- No insert/update/delete policies: service role only.

-- ---------------------------------------------------------------------------
-- Storage: public bucket for catalog photos. Size and type caps repeat the
-- admin upload checks as a second line. 4 MB stays under Vercel's 4.5 MB
-- request body limit for the upload route (apps/web lib/product-images.ts).
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 4194304,
        array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- No storage.objects policies at all for product-images. The bucket is
-- public, so /object/public/<path> serves each photo without RLS; a select
-- policy would only add object listing, which would expose the names of
-- photos for paused or archived products. Only the service role (admin
-- panel) lists, writes or removes catalog photos.
