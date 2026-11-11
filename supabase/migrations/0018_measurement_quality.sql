-- 0018_measurement_quality.sql
-- Phase 1 estimator data model, part 1 of 3 (0018, 0019, 0021; 0020 stays
-- reserved for scan_context). docs/SCAN-V3-PLAN.md sections 6.3 and 9,
-- docs/ESTIMATOR-V1.md section 2, docs/DESIGN.md sections 8 and 9. Adds:
--   A. measurement_quality: one forms.measurement-quality v1 document per
--      measurements row (per-key provenance and sigma, the fit verdict).
--      Admin and worker only: RLS enabled with no policy and every client
--      privilege revoked. A separate table, not a column on measurements,
--      because RLS cannot hide one column and a column grant is easy to undo
--      by accident (plan section 9).
--   B. measurements.superseded_at: stamped when a later row the user
--      accepted replaces this one (plan section 6.3).
--   C. accepted_measurement(scan_id): the "row the user accepted" read rule.
--
-- Ships UNWIRED: no app or worker code reads or writes any of this yet
-- (Phase 1b). In particular get_measurements (runner.py) and the app's
-- listMeasurements keep reading the newest validated row by created_at;
-- they switch to accepted_measurement when the estimator is wired.
--
-- Grants follow 0008: every function revokes execute from public and anon,
-- then grants only the intended roles.
--
-- Exercised by supabase/tests/estimator_data_checks.sql.

-- ---------------------------------------------------------------------------
-- A. measurement_quality
-- ---------------------------------------------------------------------------
create table public.measurement_quality (
  id uuid primary key default gen_random_uuid(),
  -- CASCADE: quality describes exactly one measurements row and means nothing
  -- without it; the row goes with its measurement (and so with its scan).
  measurement_id uuid not null
    constraint measurement_quality_measurement_id_uq unique
    references public.measurements(id) on delete cascade,
  -- Only the envelope is checked here. Full validation (exactly the 25 keys,
  -- the VALUE_SOURCES enum, sigma bounds) lives in the shared validators
  -- (packages/shared quality.ts, shape/contract.py), which the worker runs
  -- before writing; key names are never restated in SQL (0014 convention).
  -- coalesce: a NULL check result would otherwise pass, e.g. for '[]'.
  -- The version must be the JSON integer 1 (ESTIMATOR-V1 section 2 rule 1),
  -- so 1.0 and "1" are refused. 16 KiB is several times a full document.
  quality jsonb not null
    constraint measurement_quality_format_check check (coalesce(
      jsonb_typeof(quality) = 'object'
      and quality ->> 'format' = 'forms.measurement-quality'
      and jsonb_typeof(quality -> 'version') = 'number'
      and quality ->> 'version' = '1'
      and octet_length(quality::text) <= 16384, false)),
  created_at timestamptz not null default now()
);

comment on table public.measurement_quality is
  'forms.measurement-quality v1 per measurements row (docs/ESTIMATOR-V1.md section 2): per-key source and sigma_mm, verdict, worst key, action. Server and admin only: RLS on, no policy, no client privileges (0018). Written by the worker (Phase 1b).';

alter table public.measurement_quality enable row level security;
revoke all on public.measurement_quality from anon, authenticated;

-- ---------------------------------------------------------------------------
-- B. measurements.superseded_at
-- Written only by the worker (clients have no write policy on measurements,
-- 0002). The upsert in runner.py resets created_at on a re-run, so "newest"
-- alone would let a re-fusion outrank a later manual adjustment; an explicit
-- stamp is the fix (plan section 6.3, "No silent override through
-- created_at").
-- ---------------------------------------------------------------------------
alter table public.measurements add column superseded_at timestamptz;

comment on column public.measurements.superseded_at is
  'Set when a later row the user accepted replaces this one (plan section 6.3). accepted_measurement ignores superseded rows. Null on every row until the estimator is wired (Phase 1b).';

-- ---------------------------------------------------------------------------
-- C. accepted_measurement(scan_id)
-- The newest validated row whose superseded_at is null; NULL when none
-- qualifies. SECURITY INVOKER on purpose: the caller's RLS applies, so a
-- client gets the same answer as "measurements: select own via scan" (0002)
-- would give it (its own rows only, NULL for anyone else's scan), and a
-- definer caller such as the 0021 order snapshot reads as the owner. One rule
-- in one place (CLAUDE.md playbook rule 2).
-- ---------------------------------------------------------------------------
create function public.accepted_measurement(p_scan_id uuid)
returns public.measurements
language sql
stable
set search_path = ''
as $$
  select m.*
  from public.measurements m
  where m.scan_id = p_scan_id
    and m.validated
    and m.superseded_at is null
  order by m.created_at desc, m.id desc
  limit 1;
$$;

comment on function public.accepted_measurement(uuid) is
  'The measurements row the user accepted for a scan: newest validated, not superseded; NULL when none. Invoker, so RLS scopes clients to their own scans. Not yet read by the app or worker (Phase 1b switches get_measurements and listMeasurements to it).';

revoke execute on function public.accepted_measurement(uuid) from public, anon;
grant execute on function public.accepted_measurement(uuid) to authenticated, service_role;
