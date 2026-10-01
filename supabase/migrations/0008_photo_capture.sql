-- ---------------------------------------------------------------------------
-- 0008: photo capture, step-filtered claiming, and per-template CAD jobs.
--
-- docs/DESIGN.md sections 5 (server-side reconstruction path) and 6 (pipeline
-- state machine). Adds:
--   - scans.capture_kind: 'mesh' (on-device ObjectCapture) or 'photos'
--     (photo bundle reconstructed by a Mac worker). The photo bundle prefix is
--     DERIVED as `${user_id}/${scan_id}/`, never stored or client-supplied,
--     so there is no capture_prefix column.
--   - step 'reconstructing' between 'uploaded' and 'measuring'.
--   - pipeline_jobs.product_id: the template a CAD job renders. A measure job
--     (product_id null) completes at 'measured'; a CAD job is a separate row
--     started by the orders_enqueue_cad trigger (order paid) at 'generating_cad' and completes at
--     'stl_ready'.
--   - claim_pipeline_job filtered by step (each worker claims only the steps
--     it has handlers for: the Mac reconstructs, any worker measures).
--   - complete_pipeline_job sets the final step and succeeded atomically.
--   - owner-scoped UPDATE on the meshes bucket so client upsert retries are
--     idempotent. Still no client DELETE (0003).
--
-- Grants: Supabase's default privileges grant EXECUTE on new public-schema
-- functions to anon and authenticated directly, not only via PUBLIC, so every
-- function below revokes from public, anon AND authenticated before granting
-- the intended role. The same gap exists for the 0004/0005 helpers that are
-- not recreated here; they are re-revoked at the end of this file.
--
-- Exercised by supabase/tests/run_sql_checks.sh against a throwaway Postgres.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- scans.capture_kind
-- ---------------------------------------------------------------------------
alter table public.scans
  add column capture_kind text not null default 'mesh'
    check (capture_kind in ('mesh', 'photos'));

comment on column public.scans.capture_kind is
  'mesh: client uploaded a mesh at mesh_path. photos: client uploaded a photo bundle under meshes/<user_id>/<scan_id>/ (derived, never stored); the reconstruct step writes mesh_path. Mirrors CAPTURE_KINDS in packages/shared/src/states.ts.';

-- ---------------------------------------------------------------------------
-- pipeline_jobs: new step, product_id
-- ---------------------------------------------------------------------------
-- 0001 declared the step check inline, so Postgres named it
-- pipeline_jobs_step_check. Order mirrors PIPELINE_STEPS in
-- packages/shared/src/states.ts and STATES in jobs/states.py.
alter table public.pipeline_jobs drop constraint pipeline_jobs_step_check;
alter table public.pipeline_jobs
  add constraint pipeline_jobs_step_check check (step in (
    'captured', 'uploaded', 'reconstructing', 'measuring', 'measured',
    'generating_cad', 'stl_ready', 'queued_for_print', 'printing', 'shipped',
    'failed'
  ));

-- Null for a measure job; the chosen template (product) for a CAD job.
-- ON DELETE SET NULL keeps job history if a product row is ever removed.
alter table public.pipeline_jobs
  add column product_id uuid null references public.products(id) on delete set null;

comment on column public.pipeline_jobs.product_id is
  'Template the CAD job renders (set when a paid order enqueues CAD). Null for measure jobs. The worker resolves the CAD model as coalesce(job.product_id, order.product_id).';

-- One active measure job per scan, and one active CAD job per (scan, product).
-- Replaces 0007's single index, which forbade a CAD job while a measure job
-- was active and vice versa. Being unique indexes (not only in-function
-- SELECTs) closes the check-then-insert race between concurrent RPC calls.
drop index public.pipeline_jobs_one_active_per_scan;

create unique index pipeline_jobs_one_active_measure_per_scan
  on public.pipeline_jobs (scan_id)
  where status in ('pending', 'running') and product_id is null;

create unique index pipeline_jobs_one_active_cad_per_scan_product
  on public.pipeline_jobs (scan_id, product_id)
  where status in ('pending', 'running') and product_id is not null;

-- ---------------------------------------------------------------------------
-- claim_pipeline_job(p_worker_id, p_steps, p_limit)
-- ---------------------------------------------------------------------------
-- Dropped, not overloaded: a leftover (text, integer) overload would let an
-- old worker claim steps it has no handler for and dead-letter them.
drop function public.claim_pipeline_job(text, integer);

create function public.claim_pipeline_job(
  p_worker_id text,
  p_steps text[],
  p_limit integer default 1
)
returns setof public.pipeline_jobs
language plpgsql
as $$
begin
  -- Required: "any step" is exactly the old behavior that let a worker claim
  -- a job it could only fail.
  if p_steps is null or cardinality(p_steps) = 0 then
    raise exception 'claim_pipeline_job: p_steps must be a non-empty array'
      using errcode = 'invalid_parameter_value';
  end if;

  return query
  update public.pipeline_jobs
  set status = 'running',
      locked_by = p_worker_id,
      locked_at = now(),
      started_at = coalesce(started_at, now()),
      attempts = attempts + 1,
      updated_at = now()
  where id in (
    select id
    from public.pipeline_jobs
    where status = 'pending'
      and run_after <= now()
      and step = any(p_steps)
    order by run_after
    limit p_limit
    for update skip locked
  )
  returning *;
end;
$$;

comment on function public.claim_pipeline_job(text, text[], integer) is
  'Claim up to p_limit due pending jobs whose step is in p_steps (required, non-empty) for p_worker_id using FOR UPDATE SKIP LOCKED. Sets status=running and increments attempts.';

revoke execute on function public.claim_pipeline_job(text, text[], integer) from public, anon, authenticated;
grant execute on function public.claim_pipeline_job(text, text[], integer) to service_role;

-- ---------------------------------------------------------------------------
-- complete_pipeline_job(p_id, p_step, p_artifacts)
-- ---------------------------------------------------------------------------
-- Setting the final step and succeeded in one statement means a crash cannot
-- leave a job at its final step but still pending (the 0001 bug where a
-- 'measured' pending job was claimed and failed for lack of a handler).
drop function public.complete_pipeline_job(uuid, jsonb);

create function public.complete_pipeline_job(
  p_id uuid,
  p_step text,
  p_artifacts jsonb default null
)
returns public.pipeline_jobs
language plpgsql
as $$
declare
  v_job public.pipeline_jobs;
begin
  update public.pipeline_jobs
  set step = p_step,
      status = 'succeeded',
      locked_by = null,
      locked_at = null,
      finished_at = now(),
      artifacts = coalesce(artifacts, '{}'::jsonb) || coalesce(p_artifacts, '{}'::jsonb),
      updated_at = now()
  where id = p_id
  returning * into v_job;
  return v_job;
end;
$$;

comment on function public.complete_pipeline_job(uuid, text, jsonb) is
  'Mark a job succeeded at its final step p_step (terminal), merging p_artifacts. Measure jobs complete at measured, CAD jobs at stl_ready.';

revoke execute on function public.complete_pipeline_job(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.complete_pipeline_job(uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- enqueue_measure_job: photos scans start at 'reconstructing'.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_measure_job(p_scan_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_status text;
  v_kind text;
  v_job_id uuid;
begin
  -- Definer function bypasses RLS: it must verify the caller itself.
  select user_id, status, capture_kind
    into v_owner, v_status, v_kind
    from public.scans
    where id = p_scan_id;

  if v_owner is null then
    raise exception 'scan % not found', p_scan_id
      using errcode = 'no_data_found';
  end if;

  -- `is distinct from` so a null auth.uid() (no session) is refused too.
  if v_owner is distinct from auth.uid() then
    raise exception 'not authorized to enqueue scan %', p_scan_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_status <> 'uploaded' then
    raise exception 'scan % is not uploaded (status=%)', p_scan_id, v_status
      using errcode = 'check_violation';
  end if;

  insert into public.pipeline_jobs (scan_id, step, status)
  values (
    p_scan_id,
    case when v_kind = 'photos' then 'reconstructing' else 'measuring' end,
    'pending'
  )
  on conflict (scan_id) where status in ('pending', 'running') and product_id is null
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
    -- An active measure job already exists (retry or concurrent caller).
    select id
      into v_job_id
      from public.pipeline_jobs
      where scan_id = p_scan_id
        and product_id is null
        and status in ('pending', 'running')
      order by created_at
      limit 1;
  end if;

  return v_job_id;
end;
$$;

comment on function public.enqueue_measure_job(uuid) is
  'Client-callable (authenticated) SECURITY DEFINER RPC: enqueue the measure job for a scan the caller owns (photos scans start at reconstructing, mesh scans at measuring). Verifies auth.uid() ownership and uploaded status, and returns an existing active measure job id rather than creating a duplicate.';

revoke execute on function public.enqueue_measure_job(uuid) from public, anon;
grant execute on function public.enqueue_measure_job(uuid) to authenticated;
grant execute on function public.enqueue_measure_job(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- CAD on purchase: an order becoming 'paid' enqueues one CAD job per scan it
-- covers. Every CAD job copies the Onshape template (DESIGN.md section 7), so
-- the only path to one is a paid order; a scan alone gets a measurement-only
-- preview. A trigger (not a client RPC) means admin "mark paid" and a future
-- Stripe webhook both get it without calling anything.
-- ---------------------------------------------------------------------------
create function public.enqueue_cad_jobs_for_order(p_order_id uuid)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product_id uuid;
  v_active boolean;
  v_cad_model jsonb;
  v_scan_id uuid;
  v_job_id uuid;
begin
  select o.product_id, p.active, p.cad_model
    into v_product_id, v_active, v_cad_model
    from public.orders o
    join public.products p on p.id = o.product_id
    where o.id = p_order_id;

  if not found then
    raise exception 'order % not found', p_order_id
      using errcode = 'no_data_found';
  end if;

  -- A null cad_model would fall back to the worker's env default model, which
  -- is not the template the customer bought. Fail the payment transition
  -- loudly instead of rendering the wrong guard.
  if v_cad_model is null then
    raise exception 'product % has no CAD model', v_product_id
      using errcode = 'check_violation';
  end if;

  for v_scan_id in
    select s from public.orders o, unnest(array[o.scan_id_left, o.scan_id_right]) s
    where o.id = p_order_id and s is not null
  loop
    -- Measurements are the only CAD input; an order for an unmeasured scan
    -- cannot be fulfilled, so refuse the paid transition rather than queue a
    -- job that can never run.
    if not exists (select 1 from public.measurements where scan_id = v_scan_id) then
      raise exception 'scan % on order % has no measurements', v_scan_id, p_order_id
        using errcode = 'check_violation';
    end if;

    v_job_id := null;
    insert into public.pipeline_jobs (scan_id, product_id, order_id, step, status)
    values (v_scan_id, v_product_id, p_order_id, 'generating_cad', 'pending')
    on conflict (scan_id, product_id) where status in ('pending', 'running') and product_id is not null
    do nothing
    returning id into v_job_id;

    if v_job_id is null then
      select id
        into v_job_id
        from public.pipeline_jobs
        where scan_id = v_scan_id
          and product_id = v_product_id
          and status in ('pending', 'running')
        order by created_at
        limit 1;
    end if;

    return next v_job_id;
  end loop;
end;
$$;

comment on function public.enqueue_cad_jobs_for_order(uuid) is
  'Enqueue a generating_cad job per scan on a paid order (idempotent per active (scan, product) job). Called by the orders_enqueue_cad trigger; service role only.';

revoke execute on function public.enqueue_cad_jobs_for_order(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_cad_jobs_for_order(uuid) to service_role;

create function public.orders_enqueue_cad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.enqueue_cad_jobs_for_order(new.id);
  return new;
end;
$$;

revoke execute on function public.orders_enqueue_cad() from public, anon, authenticated;

create trigger orders_enqueue_cad
  after insert or update of status on public.orders
  for each row
  when (new.status = 'paid')
  execute function public.orders_enqueue_cad();

-- ---------------------------------------------------------------------------
-- Storage: owner-scoped UPDATE on meshes (same predicate as 0003's insert).
-- Upload retries with x-upsert overwrite the caller's own object; anything
-- outside `${auth.uid()}/` stays unreachable. No DELETE policy: clients still
-- cannot remove a scan (0003).
-- ---------------------------------------------------------------------------
create policy "meshes: update own prefix"
on storage.objects for update
to authenticated
using (
  bucket_id = 'meshes'
  and name like auth.uid()::text || '/%'
)
with check (
  bucket_id = 'meshes'
  and name like auth.uid()::text || '/%'
);

-- ---------------------------------------------------------------------------
-- Close the Supabase default-privilege gap on helpers not recreated above
-- (see header). Service-role only, as 0004/0005 intended.
-- ---------------------------------------------------------------------------
revoke execute on function public.advance_pipeline_job(uuid, text, jsonb) from anon, authenticated;
revoke execute on function public.fail_pipeline_job(uuid, jsonb, boolean) from anon, authenticated;
revoke execute on function public.get_meshes_pending_deletion(integer, integer) from anon, authenticated;
grant execute on function public.get_meshes_pending_deletion(integer, integer) to service_role;
