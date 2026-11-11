-- 0019_leg_models.sql
-- Phase 1 estimator data model, part 2 of 3. docs/SCAN-V3-PLAN.md sections
-- 7.2, 9 and 10, docs/ESTIMATOR-V1.md section 1, docs/DESIGN.md sections 8
-- and 9. Adds:
--   A. leg_models: one forms.leg-model v1 document (the 3D leg the preview
--      draws) per (scan, extraction_version), the same key as measurements,
--      so an estimator or prior bump writes a new comparable row instead of
--      overwriting the old one (plan section 6.4).
--      Owner SELECT only, through scans, like "measurements: select own via
--      scan" (0002). No client write path at all (consistent with 0017): the
--      worker writes with the service role.
--   B. export_my_data (0012) also returns the caller's leg models.
--
-- Deletion: leg_models cascades with its scan. The purge (0011, 0015
-- purge_scan_row) deletes unordered scans on scan or account deletion, so
-- their leg models go with them. Scans on a live order are kept ownerless as
-- order records (0012 B), and their leg models stay with them like their
-- measurements (plan section 10: "leg model kept with measurements"); with
-- user_id null the select policy matches no client.
--
-- Ships UNWIRED: nothing writes or reads leg_models yet (Phase 1b worker,
-- Phase 2 viewer).
--
-- Exercised by supabase/tests/estimator_data_checks.sql.

-- ---------------------------------------------------------------------------
-- A. leg_models
-- ---------------------------------------------------------------------------
create table public.leg_models (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.scans(id) on delete cascade,
  -- Same value as the measurements row it was fused with (folded estimator
  -- and prior versions, e.g. est-0.1.0+p0.1.1, ESTIMATOR-V1 Scope).
  extraction_version text not null
    constraint leg_models_extraction_version_length check (char_length(extraction_version) between 1 and 64),
  -- Envelope only; the shared validators (packages/shared legModel.ts,
  -- shape/contract.py) check rings, points and bounds before the worker
  -- writes. coalesce: a NULL check result would otherwise pass. The version
  -- must be the JSON integer 1 (ESTIMATOR-V1 section 1 rule 2). 21 rings of
  -- 48 points is about 20 KiB of JSON; 128 KiB caps a runaway writer.
  model jsonb not null
    constraint leg_models_format_check check (coalesce(
      jsonb_typeof(model) = 'object'
      and model ->> 'format' = 'forms.leg-model'
      and jsonb_typeof(model -> 'version') = 'number'
      and model ->> 'version' = '1'
      and octet_length(model::text) <= 131072, false)),
  created_at timestamptz not null default now(),
  constraint leg_models_scan_version_uq unique (scan_id, extraction_version)
);

comment on table public.leg_models is
  'forms.leg-model v1 per (scan, extraction_version) (docs/ESTIMATOR-V1.md section 1): the fused 3D leg for the preview. Owner SELECT via scans; no client writes; cascades with the scan; in export_my_data (0019).';

alter table public.leg_models enable row level security;
revoke all on public.leg_models from anon, authenticated;
grant select on public.leg_models to authenticated;

create policy "leg_models: select own via scan"
on public.leg_models for select
to authenticated
using (
  scan_id in (select id from public.scans where user_id = auth.uid())
);

-- ---------------------------------------------------------------------------
-- B. export_my_data: the 0012 body unchanged, plus leg_models (plan
-- section 10: data export covers leg_models). measurement_quality is not
-- added: it is server and admin only (0018).
-- ---------------------------------------------------------------------------
create or replace function public.export_my_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'exported_at', now(),
    'account', (
      select jsonb_build_object('user_id', u.id, 'email', u.email,
        'is_anonymous', u.is_anonymous, 'created_at', u.created_at)
      from auth.users u where u.id = v_uid),
    'profile', (select to_jsonb(p) from public.profiles p where p.user_id = v_uid),
    'scans', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'leg', s.leg, 'status', s.status,
        'pair_id', s.pair_id, 'created_at', s.created_at, 'deleted_at', s.deleted_at,
        'mesh_deleted_at', s.mesh_deleted_at) order by s.created_at)
      from public.scans s where s.user_id = v_uid), '[]'::jsonb),
    'measurements', coalesce((
      select jsonb_agg(jsonb_build_object('scan_id', m.scan_id, 'schema_version', m.schema_version,
        'values', m."values", 'created_at', m.created_at) order by m.created_at)
      from public.measurements m join public.scans s on s.id = m.scan_id
      where s.user_id = v_uid), '[]'::jsonb),
    'leg_models', coalesce((
      select jsonb_agg(jsonb_build_object('scan_id', lm.scan_id,
        'extraction_version', lm.extraction_version, 'model', lm.model,
        'created_at', lm.created_at) order by lm.created_at)
      from public.leg_models lm join public.scans s on s.id = lm.scan_id
      where s.user_id = v_uid), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'status', o.status,
        'amount_cents', o.amount_cents, 'address', o.address,
        'tracking_carrier', o.tracking_carrier, 'tracking_number', o.tracking_number,
        'created_at', o.created_at, 'product_name', p.name) order by o.created_at)
      from public.orders o join public.products p on p.id = o.product_id
      where o.user_id = v_uid), '[]'::jsonb)
  );
end;
$$;

comment on function public.export_my_data() is
  'Signed-in caller: their account, profile, scans, measurements, leg models and orders as one JSON document. No storage paths.';

revoke execute on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;
