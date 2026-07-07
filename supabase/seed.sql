-- seed.sql
-- Local/dev seed data, applied after migrations by `supabase db reset`.
-- Idempotent: safe to re-run against a database that already has this row.

-- The demo product carries a "dry_run" CAD descriptor so the local pipeline
-- (queue -> extraction -> CAD -> STL) runs end to end without any Onshape
-- account: the dry-run provider returns a canned STL. Swap provider to
-- "onshape" and fill ref with real document/workspace/element ids to drive a
-- real model.
insert into public.products (name, slug, base_price_cents, currency, active, cad_model)
values (
  'Zells Custom Shin Guard', 'custom-guard', 8900, 'usd', true,
  jsonb_build_object(
    'provider', 'dry_run',
    'schema_version', '1.0.0',
    'ref', '{}'::jsonb,
    'variable_map', null
  )
)
on conflict (slug) do update set cad_model = excluded.cad_model;
