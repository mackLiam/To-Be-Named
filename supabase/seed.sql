-- seed.sql
-- Local/dev seed data, applied after migrations by `supabase db reset`.
-- Idempotent: safe to re-run against a database that already has this row.

insert into public.products (name, slug, base_price_cents, currency, active)
values ('Zells Custom Shin Guard', 'custom-guard', 8900, 'usd', true)
on conflict (slug) do nothing;
