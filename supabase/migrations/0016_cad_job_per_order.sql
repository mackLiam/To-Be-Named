-- 0016_cad_job_per_order.sql
-- One active CAD job per (order, scan), not per (scan, product).
--
-- 0008 deduplicated CAD jobs on (scan_id, product_id). A reorder of the same
-- guard from the same scan (DESIGN.md section 5: reorders reuse stored
-- measurements) placed while the first order's job is still pending or
-- running hit that index, did nothing, and was handed the first order's job
-- id: the second order got no job of its own, so nothing ever rendered or
-- tracked its STL. The real invariant is one active job per order per leg:
-- a replayed paid transition for the SAME order is still absorbed, a second
-- order gets its own job.

drop index public.pipeline_jobs_one_active_cad_per_scan_product;

-- order_id is set by enqueue_cad_jobs_for_order; it only becomes null when
-- the order row is deleted (ON DELETE SET NULL), and those nulls must not
-- collide, so nulls stay distinct.
create unique index pipeline_jobs_one_active_cad_per_order_scan
  on public.pipeline_jobs (order_id, scan_id)
  where status in ('pending', 'running') and product_id is not null;

-- Same as 0008 except the conflict target and the existing-job lookup, which
-- now key on (order_id, scan_id).
create or replace function public.enqueue_cad_jobs_for_order(p_order_id uuid)
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
  -- is not the template the customer bought.
  if v_cad_model is null then
    raise exception 'product % has no CAD model', v_product_id
      using errcode = 'check_violation';
  end if;

  for v_scan_id in
    select s from public.orders o, unnest(array[o.scan_id_left, o.scan_id_right]) s
    where o.id = p_order_id and s is not null
  loop
    if not exists (select 1 from public.measurements where scan_id = v_scan_id) then
      raise exception 'scan % on order % has no measurements', v_scan_id, p_order_id
        using errcode = 'check_violation';
    end if;

    v_job_id := null;
    insert into public.pipeline_jobs (scan_id, product_id, order_id, step, status)
    values (v_scan_id, v_product_id, p_order_id, 'generating_cad', 'pending')
    on conflict (order_id, scan_id) where status in ('pending', 'running') and product_id is not null
    do nothing
    returning id into v_job_id;

    if v_job_id is null then
      select id
        into v_job_id
        from public.pipeline_jobs
        where order_id = p_order_id
          and scan_id = v_scan_id
          and product_id is not null
          and status in ('pending', 'running')
        order by created_at
        limit 1;
    end if;

    return next v_job_id;
  end loop;
end;
$$;

revoke execute on function public.enqueue_cad_jobs_for_order(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_cad_jobs_for_order(uuid) to service_role;
