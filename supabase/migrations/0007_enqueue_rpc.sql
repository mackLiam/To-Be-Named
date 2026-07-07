-- ---------------------------------------------------------------------------
-- 0007: client-callable RPC to enqueue the measurement job for an owned scan.
--
-- Why this exists: the queue helpers in 0001 (claim/advance/complete/fail) are
-- service-role only (revoked from PUBLIC in 0005), and pipeline_jobs has no RLS
-- policy at all (0002), so an authenticated client cannot enqueue a job by any
-- direct route. The app's upload path (apps/app/src/lib/upload.ts) needs to
-- enqueue the measure job right after it writes the scan row, using the user's
-- own session. This SECURITY DEFINER function is that single, audited entry
-- point: it runs as its owner (bypassing RLS on pipeline_jobs) but re-derives
-- the caller and enforces ownership + status itself, so the client is never
-- trusted (apps/app/CLAUDE.md "Upload path reasoning").
--
-- SECURITY DEFINER + `set search_path = public`: pin the schema so the function
-- resolves its own tables regardless of the caller's search_path (a standard
-- definer-function hardening; without it a caller could shadow `scans` with a
-- table in their own schema).
--
-- Verified by review, not by an automated harness (repo convention, see 0005
-- and ROADMAP.md week 5): SQL migrations are review-only until a hosted test
-- project exists. The ownership check and duplicate-job guard below are
-- therefore commented in detail since they cannot be integration-tested here.
-- ---------------------------------------------------------------------------

-- Duplicate-job guard, part 1: a partial unique index enforcing at most one
-- ACTIVE (pending or running) job per scan. In this pipeline a single job row
-- advances through steps (0001 helpers reuse the row via advance_pipeline_job),
-- so "one active job per scan" is a true invariant, not just a convenience.
-- Making it an index (not only an in-function SELECT) closes the check-then-
-- insert race between two concurrent enqueue calls for the same scan: the
-- second INSERT hits the index and is turned into a no-op by ON CONFLICT below.
-- A terminal job (succeeded/failed/dead_letter) is not in the index, so a
-- deliberate future re-run can still enqueue.
create unique index if not exists pipeline_jobs_one_active_per_scan
  on public.pipeline_jobs (scan_id)
  where status in ('pending', 'running');

create or replace function public.enqueue_measure_job(p_scan_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_status text;
  v_job_id uuid;
begin
  -- Ownership + status lookup. Because this function bypasses RLS, it MUST
  -- verify the caller itself; auth.uid() reads the request's JWT claim and is
  -- valid inside a definer function.
  select user_id, status
    into v_owner, v_status
    from public.scans
    where id = p_scan_id;

  if v_owner is null then
    raise exception 'scan % not found', p_scan_id
      using errcode = 'no_data_found';
  end if;

  if v_owner <> auth.uid() then
    -- The caller does not own this scan. Refuse: an authenticated user must
    -- never be able to enqueue work against someone else's body scan.
    raise exception 'not authorized to enqueue scan %', p_scan_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Status gate: only a fully uploaded scan is ready to measure. Enqueuing a
  -- scan that is still capturing (mesh not uploaded yet) or already failed
  -- would hand the worker a mesh that is not there.
  if v_status <> 'uploaded' then
    raise exception 'scan % is not uploaded (status=%)', p_scan_id, v_status
      using errcode = 'check_violation';
  end if;

  -- Duplicate-job guard, part 2: insert the measure job, but let the partial
  -- unique index above absorb a concurrent/retried duplicate. ON CONFLICT ...
  -- DO NOTHING means the second caller inserts nothing and RETURNING yields no
  -- row, so v_job_id stays null and we fall through to fetch the existing one.
  insert into public.pipeline_jobs (scan_id, step, status)
  values (p_scan_id, 'measuring', 'pending')
  on conflict (scan_id) where status in ('pending', 'running')
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
    -- Either the insert was a no-op (an active job already existed) or a
    -- concurrent caller won the race: return the existing active job id so the
    -- upload path is idempotent on retry.
    select id
      into v_job_id
      from public.pipeline_jobs
      where scan_id = p_scan_id
        and status in ('pending', 'running')
      order by created_at
      limit 1;
  end if;

  return v_job_id;
end;
$$;

comment on function public.enqueue_measure_job(uuid) is
  'Client-callable (authenticated) SECURITY DEFINER RPC: enqueue the measuring job for a scan the caller owns. Verifies auth.uid() ownership and uploaded status, and returns an existing active job id rather than creating a duplicate. Called by the app upload path (apps/app/src/lib/upload.ts).';

-- Grants (0005 convention): revoke the default PUBLIC execute, then grant only
-- to the roles that legitimately call it. authenticated: the owning user's
-- session (the intended client path). service_role: the worker/admin paths.
-- anon is deliberately excluded (no scan to enqueue without a session).
revoke execute on function public.enqueue_measure_job(uuid) from public;
grant execute on function public.enqueue_measure_job(uuid) to authenticated;
grant execute on function public.enqueue_measure_job(uuid) to service_role;
