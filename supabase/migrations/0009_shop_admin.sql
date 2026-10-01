-- 0009_shop_admin.sql
-- Columns the admin panel needs to run the shop: catalog copy and imagery
-- the app's Shop tab renders, and shipment tracking on orders.
--
-- Catalog writes stay service-role only (admin panel, 0002 "products"
-- comment); availability is products.active, which already exists. There is
-- no stock count: every guard is printed to order, so "available" is a flag,
-- not an inventory number.

alter table public.products
  add column description text not null default '',
  -- Remote image the Shop tab loads. https only so the app never fetches
  -- mixed content; null means the card renders without a picture.
  add column image_url text
    constraint products_image_url_https check (image_url is null or image_url ~ '^https://');

comment on column public.products.description is
  'One or two sentences of shop copy shown under the product name.';
comment on column public.products.image_url is
  'https URL of the product image shown in the shop. Null renders no image.';

-- Tracking is customer-visible on purpose: "orders: select own" (0002) lets
-- a user read their whole order row, and the carrier + number are exactly
-- what they need to follow the parcel. Nothing internal goes in these
-- columns; admin history lives in audit_log (subject_table = 'orders').
alter table public.orders
  add column tracking_carrier text,
  add column tracking_number text;

comment on column public.orders.tracking_number is
  'Carrier tracking number, set by the admin panel when the order ships.';

-- Admin order list filters by status, newest first.
create index orders_status_created_idx on public.orders(status, created_at desc);
