-- 0014_manual_measurements.sql
-- Hand-entered and adjusted measurements. docs/DESIGN.md sections 6 (pipeline
-- state machine) and 9 (security). Adds:
--   - scans.capture_kind 'manual': a scan row with no mesh, created by the
--     client (mesh_path null, status 'uploaded') so the user can enter their
--     measurements after a failed scan.
--   - measurements.source: 'scan' (extracted from a mesh) or 'manual'.
--   - submit_manual_measurements: queues a measure job carrying the client's
--     values. Client values are never trusted: the worker re-runs the same
--     schema gates the scan path uses and is the only writer of the
--     measurements row (RLS 0002 gives clients no write on measurements).
--     Key names and ranges live only in the packages/shared JSON Schema, so
--     this file checks shape and size, never names or ranges.
--
-- scans.status needs no change: pipeline_jobs_sync_scan_status (0013 E)
-- moves any non-capturing scan to processing on the job insert, to ready on
-- success and to failed on dead letter, from ready and failed as well.
--
-- Exercised by supabase/tests/manual_measurements_checks.sql.

-- 0008 declared the check inline on add column, so Postgres named it
-- scans_capture_kind_check. Mirrors CAPTURE_KINDS in packages/shared/src/states.ts.
alter table public.scans drop constraint scans_capture_kind_check;
alter table public.scans
  add constraint scans_capture_kind_check check (capture_kind in ('mesh', 'photos', 'manual'));

alter table public.measurements
  add column source text not null default 'scan'
    constraint measurements_source_check check (source in ('scan', 'manual'));

comment on column public.measurements.source is
  'scan: extracted from the mesh. manual: entered or adjusted by the user (extraction_version manual-1), gated by the worker like a scan. Written only by the worker.';

create function public.submit_manual_measurements(p_scan_id uuid, p_values jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_status text;
  v_deleted_at timestamptz;
  v_job_id uuid;
begin
  -- Definer function bypasses RLS: it must verify the caller itself. The row
  -- lock serializes with request_scan_deletion so no job lands after it.
  select user_id, status, deleted_at
    into v_owner, v_status, v_deleted_at
    from public.scans
    where id = p_scan_id
    for update;

  if v_owner is null then
    raise exception 'scan % not found', p_scan_id
      using errcode = 'no_data_found';
  end if;

  -- `is distinct from` so a null auth.uid() (no session) is refused too.
  if v_owner is distinct from auth.uid() then
    raise exception 'not authorized to submit measurements for scan %', p_scan_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_deleted_at is not null then
    raise exception 'scan % was deleted', p_scan_id
      using errcode = 'check_violation';
  end if;

  -- Same rule as enqueue_measure_job: a scan still uploading has no settled
  -- row yet, and the E trigger would not show progress for it.
  if v_status = 'capturing' then
    raise exception 'scan % is still capturing', p_scan_id
      using errcode = 'check_violation';
  end if;

  -- 4096 bytes is far above 25 numeric fields; it caps what a client can
  -- park in pipeline_jobs.artifacts.
  if p_values is null or jsonb_typeof(p_values) <> 'object' then
    raise exception 'measurements must be a JSON object'
      using errcode = 'invalid_parameter_value';
  end if;
  if octet_length(p_values::text) > 4096 then
    raise exception 'measurements payload is too large'
      using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from jsonb_each(p_values) e where jsonb_typeof(e.value) <> 'number') then
    raise exception 'every measurement must be a number'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The 0008 partial unique index makes the conflict check race-free.
  insert into public.pipeline_jobs (scan_id, step, status, artifacts)
  values (p_scan_id, 'measuring', 'pending',
    jsonb_build_object('source', 'manual', 'values', p_values))
  on conflict (scan_id) where status in ('pending', 'running') and product_id is null
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
    raise exception 'A measurement is already in progress for this scan.'
      using errcode = 'lock_not_available';
  end if;

  return v_job_id;
end;
$$;

comment on function public.submit_manual_measurements(uuid, jsonb) is
  'Client-callable (authenticated) SECURITY DEFINER RPC: queue a measure job at measuring with artifacts {source: manual, values}. Verifies auth.uid() ownership; refuses deleted or capturing scans, a non-object, oversize (>4096 bytes) or non-numeric payload, and a scan with an active measure job (55P03). The worker validates names and ranges against the shared schema.';

revoke execute on function public.submit_manual_measurements(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.submit_manual_measurements(uuid, jsonb) to authenticated;
grant execute on function public.submit_manual_measurements(uuid, jsonb) to service_role;
