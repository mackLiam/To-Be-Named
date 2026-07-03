-- 0004_retention.sql
-- Raw-mesh retention sweep support (docs/DESIGN.md section 9.3,
-- docs/ROADMAP.md week 8): "raw meshes auto-deleted N days after the job
-- completes, measurements JSON kept forever." This is both the privacy
-- policy (scans are sensitive, likely-minors body data) and the storage
-- cost control (meshes are 10-100 MB each).
--
-- `public.scans.mesh_deleted_at` already exists (0001_schema.sql) as the
-- "is the raw mesh gone" marker, so this migration only adds what the
-- retention sweep needs on top of it: an index to find eligible scans
-- cheaply, and a read-only helper function returning the batch of scans
-- whose mesh is due for deletion.
--
-- "Job completes" is defined here as: at least one pipeline_jobs row for
-- the scan has reached status = 'succeeded' (finished_at set by
-- complete_pipeline_job), and no pipeline_jobs row for that scan is still
-- pending/running. Reordering only ever needs the measurements row (see
-- DESIGN.md section 5), never the raw mesh, so this does not consider
-- order status at all -- see the pipeline worker's retention module for the
-- fuller rationale and the note on revisiting this once order fulfillment
-- (Phase 2+) is wired up.

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Foreign-key column with no supporting index yet; the retention query below
-- joins pipeline_jobs to scans by scan_id, and this is also generally good
-- practice for a FK column that gets looked up often (e.g. job history for a
-- scan in the admin panel).
create index pipeline_jobs_scan_id_idx on public.pipeline_jobs(scan_id);

-- Partial index scoped to exactly the rows the retention sweep cares about:
-- scans with a mesh that hasn't been deleted yet. As scans accumulate and
-- most of them age past retention and get their mesh deleted, this index
-- stays small (only the still-undeleted tail), keeping the sweep's lookup
-- cheap regardless of total scan volume.
create index scans_mesh_undeleted_idx on public.scans(id)
  where mesh_path is not null and mesh_deleted_at is null;

-- ---------------------------------------------------------------------------
-- get_meshes_pending_deletion: batch of scans eligible for mesh deletion.
--
-- Read-only (language sql, stable), so -- like the queue helpers in
-- 0001_schema.sql -- it is plain rather than SECURITY DEFINER: in practice
-- this is always called over the pipeline worker's service_role connection,
-- which already bypasses RLS, so no elevated-privilege wrapper is needed.
--
-- Unlike the queue helpers, this function's result set spans every user's
-- scans and includes storage paths (which embed user_id as a prefix, see
-- 0003_storage.sql), so it must never be reachable by anon/authenticated --
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and
-- Supabase's PostgREST exposes every public-schema function as an RPC
-- endpoint. The explicit revoke below closes that off. (Flag for review:
-- the same latent PUBLIC-execute exposure likely applies to the queue
-- helper functions in 0001_schema.sql; out of scope to edit an already-
-- shipped migration here, but worth a follow-up migration.)
-- ---------------------------------------------------------------------------
create or replace function public.get_meshes_pending_deletion(
  p_retention_days integer default 30,
  p_limit integer default 100
)
returns table (scan_id uuid, mesh_path text, job_completed_at timestamptz)
language sql
stable
as $$
  select s.id as scan_id, s.mesh_path, agg.completed_at as job_completed_at
  from public.scans s
  cross join lateral (
    select
      max(pj.finished_at) filter (where pj.status = 'succeeded') as completed_at,
      bool_or(pj.status in ('pending', 'running')) as has_active_job
    from public.pipeline_jobs pj
    where pj.scan_id = s.id
  ) agg
  where s.mesh_path is not null
    and s.mesh_deleted_at is null
    and agg.completed_at is not null
    and not coalesce(agg.has_active_job, false)
    and agg.completed_at <= now() - make_interval(days => p_retention_days)
  order by agg.completed_at
  limit p_limit;
$$;

comment on function public.get_meshes_pending_deletion(integer, integer) is
  'Batch of scans whose mesh is due for deletion: at least one pipeline_jobs row succeeded, none still pending/running, more than p_retention_days since the last success, mesh not yet deleted. LIMIT-capped via p_limit. Service-role only, see revoke below.';

revoke execute on function public.get_meshes_pending_deletion(integer, integer) from public;
