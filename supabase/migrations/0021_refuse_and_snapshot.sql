-- 0021_refuse_and_snapshot.sql
-- Phase 1 estimator data model, part 3 of 3 (0020 stays reserved for
-- scan_context, pending legal review). docs/SCAN-V3-PLAN.md sections 6.3
-- and 9, docs/DESIGN.md sections 6, 8 and 9. Adds:
--   A. request_scan_refusion(scan_id): the owner asks for a fresh measure job
--      on a scan that is already ready (late player answers, the check card,
--      pair completion). Refused when the user's own numbers or a paid
--      order's CAD input would change behind their back.
--   B. The order measurement snapshot: on the transition to paid, each leg's
--      accepted measurement (the 25 values, versions, measurement id) and
--      leg model id are copied onto the order, so nothing that happens to the
--      scan after payment can change what is printed.
--
-- Ships UNWIRED. request_scan_refusion has no caller yet, and the CAD job
-- still reads measurements the old way (runner.py get_measurements); wiring
-- the CAD job to read only the snapshot is Phase 1b (plan section 6.3).
--
-- Grants follow 0008. SQLSTATEs follow 0012: 42501 not allowed for this
-- caller, 22023 bad input, 23514 refused by current state.
--
-- Exercised by supabase/tests/estimator_data_checks.sql.

-- ---------------------------------------------------------------------------
-- A. request_scan_refusion
-- No caller yet: the late-answers RPC, the check card and pair completion
-- (plan section 6.3) will call it in Phase 1b. That is deliberate.
--
-- Skip conditions (plan section 6.3):
--   - any measurements row with source 'manual'. "Adjusted" rows are written
--     with source 'manual' too (0014), so SQL cannot tell them apart today;
--     refusing on either is the conservative reading.
--   - the scan is on a paid order (paid_at stamped on every path to paid by
--     0015, including remakes and orders paid after cancellation; the status
--     list covers rows past paid). pending_payment is not refused: the
--     snapshot (B) freezes whatever is accepted at the moment of payment.
-- Also refused, because the measure job would fail and the 0013 E trigger
-- would then mark a good scan 'failed': a deleted scan, and a scan whose raw
-- capture retention already erased (0015 E; fusing from stored values
-- instead is the plan section 6.4 backfill, a worker path, not this RPC).
--
-- Concurrency: the insert below is the one in enqueue_measure_job (0013 G),
-- so the 0008 one-active-measure-job index absorbs a racing or repeated
-- call, and an active measure job is returned as success (idempotent). The
-- scan row lock serializes with request_scan_deletion and
-- submit_manual_measurements; the order share lock with the paid
-- transition (lock order scan, then orders, as in 0015 purge_scan_row).
--
-- The job starts at 'measuring' even for photos scans: a ready scan was
-- already reconstructed, and the plan's re-fusion reads stored observations
-- (plan section 6.3, "The job is cheap").
-- ---------------------------------------------------------------------------
create function public.request_scan_refusion(p_scan_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_owner uuid;
  v_status text;
  v_deleted_at timestamptz;
  v_mesh_deleted_at timestamptz;
  v_job_id uuid;
begin
  if v_uid is null then
    raise exception 'not signed in' using errcode = 'insufficient_privilege';
  end if;
  if p_scan_id is null then
    raise exception 'scan id is required' using errcode = 'invalid_parameter_value';
  end if;

  select s.user_id, s.status, s.deleted_at, s.mesh_deleted_at
    into v_owner, v_status, v_deleted_at, v_mesh_deleted_at
    from public.scans s
    where s.id = p_scan_id
    for update;

  -- Definer bypasses RLS, so ownership is checked here. A missing scan gets
  -- the same answer as someone else's, so ids cannot be probed. `is distinct
  -- from` also refuses ownerless rows (account deleted, 0012 B).
  if v_owner is distinct from v_uid then
    raise exception 'not authorized to re-measure scan %', p_scan_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_deleted_at is not null then
    raise exception 'scan % was deleted', p_scan_id using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.measurements m
    where m.scan_id = p_scan_id and m.source = 'manual'
  ) then
    raise exception 'scan % has entered or adjusted measurements', p_scan_id
      using errcode = 'check_violation';
  end if;

  perform 1 from public.orders o
    where o.scan_id_left = p_scan_id or o.scan_id_right = p_scan_id
    for share;
  if exists (
    select 1 from public.orders o
    where (o.scan_id_left = p_scan_id or o.scan_id_right = p_scan_id)
      and (o.paid_at is not null
        or o.status in ('paid', 'in_production', 'shipped', 'delivered'))
  ) then
    raise exception 'scan % is on a paid order', p_scan_id using errcode = 'check_violation';
  end if;

  if v_mesh_deleted_at is not null then
    raise exception 'scan % raw capture was already erased', p_scan_id
      using errcode = 'check_violation';
  end if;

  -- Already re-measuring (or measuring for any other reason): success, the
  -- existing job. Checked before the status gate because the first call's
  -- insert moves the scan to 'processing' (0013 E).
  select pj.id
    into v_job_id
    from public.pipeline_jobs pj
    where pj.scan_id = p_scan_id
      and pj.product_id is null
      and pj.status in ('pending', 'running')
    order by pj.created_at
    limit 1;
  if v_job_id is not null then
    return v_job_id;
  end if;

  if v_status <> 'ready' then
    raise exception 'scan % is not ready (status=%)', p_scan_id, v_status
      using errcode = 'check_violation';
  end if;

  insert into public.pipeline_jobs (scan_id, step, status)
  values (p_scan_id, 'measuring', 'pending')
  on conflict (scan_id) where status in ('pending', 'running') and product_id is null
  do nothing
  returning id into v_job_id;

  if v_job_id is null then
    -- A concurrent caller won the race under the 0008 index.
    select pj.id
      into v_job_id
      from public.pipeline_jobs pj
      where pj.scan_id = p_scan_id
        and pj.product_id is null
        and pj.status in ('pending', 'running')
      order by pj.created_at
      limit 1;
  end if;

  return v_job_id;
end;
$$;

comment on function public.request_scan_refusion(uuid) is
  'Owner-only (authenticated) SECURITY DEFINER RPC: enqueue a fresh measure job at measuring for a ready scan (plan section 6.3). Refused (23514) for a deleted scan, a scan with any manual row, a scan on a paid order, an erased raw capture, or a scan not ready; 42501 for no session or not the owner. Returns the active measure job when one exists. No caller yet (Phase 1b).';

revoke execute on function public.request_scan_refusion(uuid) from public, anon, authenticated, service_role;
grant execute on function public.request_scan_refusion(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- B. Order measurement snapshot (plan section 6.3, "The order snapshots its
-- inputs").
--
-- Shape: one self-contained object per leg, not one column per field. The
-- two legs of an order are separate scans that may carry different
-- extraction versions and sources (one leg scanned, the other typed), and
-- the CAD job runs per (order, scan) (0016), so each job reads exactly one
-- object holding its values together with the version and row they came
-- from. A single extraction_version column would be wrong for a mixed pair,
-- and a uuid[] of leg models would lose which leg each belongs to.
--
--   snapshot_left / snapshot_right: null, or
--     { "format": "forms.order-leg-snapshot", "version": 1,
--       "scan_id": uuid, "measurement_id": uuid,
--       "schema_version": text, "extraction_version": text,
--       "source": "scan" | "manual",
--       "values": { the 25 values in mm, as stored },
--       "leg_model_id": uuid | null }
--   snapshot_at: when the snapshot was taken; null when no leg was captured.
--
-- A leg is null when its scan has no accepted row (accepted_measurement,
-- 0018: none validated, or all superseded) or the row's values are not an
-- object of 25 numbers. leg_model_id is null when no leg model exists for
-- that row's extraction_version (every v2 scan today), so v2 orders get a
-- snapshot too (plan section 6.3, "closes that gap for v2 scans too").
-- A remake (0024) copies the original order's leg object for the same scan
-- when there is one, so a remake prints what was paid for; otherwise it
-- takes the accepted row like any other order.
--
-- Never blocks a payment. A trigger that raises aborts the paid transition
-- (stripe_checkout_completed, the admin mark-paid, create_order_remake).
-- So: every read is a plain non-strict select or a function returning NULL
-- on no row; the values are type-checked before use, never cast; and the
-- whole read-and-write runs inside an exception block, so anything that
-- still goes wrong (including a constraint or another trigger fired by the
-- snapshot UPDATE) rolls back only that block, leaves the snapshot null, and
-- the payment commits. The failure is recorded in audit_log as
-- 'order.snapshot_failed' (SQLSTATE only, never values), itself guarded.
-- The AFTER trigger's UPDATE sets only snapshot columns, so it fires none of
-- the "update of status" or "update of scan_id_*" triggers on orders again,
-- only set_updated_at.
--
-- Write-once: the UPDATE requires snapshot_at is null, so a status moved
-- back to paid by an admin never re-snapshots a filled order.
--
-- A paid transition for a scan with no measurements row at all is still
-- refused before this runs, by enqueue_cad_jobs_for_order (0008, 0016), as
-- it always has been. That refusal predates and is unchanged by this file.
--
-- Clients: "orders: select own" (0002) lets owners read their own snapshot
-- (their own values); orders has no client insert or update policy (0017),
-- so clients cannot write these columns.
-- ---------------------------------------------------------------------------
alter table public.orders
  add column snapshot_left jsonb,
  add column snapshot_right jsonb,
  add column snapshot_at timestamptz;

-- Envelope checks only. They cannot block a payment: the snapshot is the
-- only writer, and its UPDATE runs inside the guarded block.
alter table public.orders
  add constraint orders_snapshot_left_format check (snapshot_left is null or coalesce(
    jsonb_typeof(snapshot_left) = 'object'
    and snapshot_left ->> 'format' = 'forms.order-leg-snapshot'
    and snapshot_left ->> 'version' = '1', false)),
  add constraint orders_snapshot_right_format check (snapshot_right is null or coalesce(
    jsonb_typeof(snapshot_right) = 'object'
    and snapshot_right ->> 'format' = 'forms.order-leg-snapshot'
    and snapshot_right ->> 'version' = '1', false)),
  add constraint orders_snapshot_at_together
    check ((snapshot_at is null) = (snapshot_left is null and snapshot_right is null));

comment on column public.orders.snapshot_left is
  'forms.order-leg-snapshot v1 for scan_id_left, copied at the paid transition (0021): values, versions, measurement id, leg model id. Null when nothing accepted was available. Phase 1b: the CAD job reads only this.';
comment on column public.orders.snapshot_right is
  'As snapshot_left, for scan_id_right (0021).';
comment on column public.orders.snapshot_at is
  'When the measurement snapshot was taken (0021). Null when no leg was captured. Set once, never overwritten.';

-- One leg's snapshot object, or NULL. Reads only; never writes. Invoker: it
-- is called only by snapshot_order_measurements, which runs as the owner.
create function public.order_leg_snapshot(p_scan_id uuid, p_remake_of uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_prev jsonb;
  v_m public.measurements;
  v_leg_model_id uuid;
begin
  if p_scan_id is null then
    return null;
  end if;

  if p_remake_of is not null then
    select case
             when o.snapshot_left ->> 'scan_id' = p_scan_id::text then o.snapshot_left
             when o.snapshot_right ->> 'scan_id' = p_scan_id::text then o.snapshot_right
           end
      into v_prev
      from public.orders o
      where o.id = p_remake_of;
    if v_prev is not null then
      return v_prev;
    end if;
  end if;

  v_m := public.accepted_measurement(p_scan_id);
  if v_m.id is null then
    return null;
  end if;

  -- Separate checks, in order: jsonb_each raises on a non-object, and SQL
  -- does not promise left-to-right evaluation of OR. 25 is the frozen
  -- contract's key count (CLAUDE.md gotcha 2); names stay out of SQL.
  if jsonb_typeof(v_m."values") is distinct from 'object' then
    return null;
  end if;
  if (select count(*) from jsonb_each(v_m."values")) <> 25 then
    return null;
  end if;
  if exists (select 1 from jsonb_each(v_m."values") e where jsonb_typeof(e.value) <> 'number') then
    return null;
  end if;

  select lm.id
    into v_leg_model_id
    from public.leg_models lm
    where lm.scan_id = p_scan_id
      and lm.extraction_version = v_m.extraction_version
    limit 1;

  return jsonb_build_object(
    'format', 'forms.order-leg-snapshot',
    'version', 1,
    'scan_id', p_scan_id,
    'measurement_id', v_m.id,
    'schema_version', v_m.schema_version,
    'extraction_version', v_m.extraction_version,
    'source', v_m.source,
    'values', v_m."values",
    'leg_model_id', v_leg_model_id);
end;
$$;

comment on function public.order_leg_snapshot(uuid, uuid) is
  'Internal (0021): one leg''s forms.order-leg-snapshot v1 object from the remake original or the accepted measurement, or NULL. Read-only. Owner only.';

revoke execute on function public.order_leg_snapshot(uuid, uuid) from public, anon, authenticated, service_role;

-- Fill an order's snapshot. Returns true when it wrote one, false otherwise
-- (no such order, already taken, nothing accepted, or any error). Never
-- raises (see the B header).
create function public.snapshot_order_measurements(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scan_left uuid;
  v_scan_right uuid;
  v_remake_of uuid;
  v_snapshot_at timestamptz;
  v_left jsonb;
  v_right jsonb;
begin
  begin
    select o.scan_id_left, o.scan_id_right, o.remake_of, o.snapshot_at
      into v_scan_left, v_scan_right, v_remake_of, v_snapshot_at
      from public.orders o
      where o.id = p_order_id;
    if not found or v_snapshot_at is not null then
      return false;
    end if;

    v_left := public.order_leg_snapshot(v_scan_left, v_remake_of);
    v_right := public.order_leg_snapshot(v_scan_right, v_remake_of);
    if v_left is null and v_right is null then
      return false;
    end if;

    update public.orders
      set snapshot_left = v_left,
          snapshot_right = v_right,
          snapshot_at = now()
      where id = p_order_id
        and snapshot_at is null;
    return found;
  exception when others then
    begin
      insert into public.audit_log (actor, action, subject_table, subject_id, detail)
      values ('db', 'order.snapshot_failed', 'orders', p_order_id,
        jsonb_build_object('sqlstate', sqlstate));
    exception when others then
      raise warning 'order % measurement snapshot failed (SQLSTATE %)', p_order_id, sqlstate;
    end;
    return false;
  end;
end;
$$;

comment on function public.snapshot_order_measurements(uuid) is
  'Internal (0021): copy each leg''s accepted measurement (or a remake original''s leg snapshot) onto the order once. Never raises: any failure leaves the snapshot null and is audited as order.snapshot_failed. Called by the orders_snapshot_measurements trigger. Owner only.';

revoke execute on function public.snapshot_order_measurements(uuid) from public, anon, authenticated, service_role;

create function public.orders_snapshot_measurements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- snapshot_order_measurements already never raises; this second guard
  -- keeps the payment safe even if that function is ever replaced.
  begin
    perform public.snapshot_order_measurements(new.id);
  exception when others then
    null;
  end;
  return null;
end;
$$;

revoke execute on function public.orders_snapshot_measurements() from public, anon, authenticated, service_role;

-- Same firing rule as orders_enqueue_cad (0008): an insert as paid (a
-- remake, 0024) or a status update to paid.
create trigger orders_snapshot_measurements
  after insert or update of status on public.orders
  for each row
  when (new.status = 'paid' and new.snapshot_at is null)
  execute function public.orders_snapshot_measurements();
