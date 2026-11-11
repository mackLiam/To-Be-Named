-- 0024_order_remakes.sql
-- Remakes: the admin reprints a shipped or delivered order at no charge, for
-- a recorded reason. docs/BUSINESS-GAPS.md rank 6, docs/DESIGN.md section 8.
--
-- Design: a remake is a NEW orders row pointing at the order it replaces
-- (remake_of), created already 'paid' with amount 0 and no Stripe ids. Not a
-- side table of extra jobs on the original order, because:
--   - It gets its own status, tracking, shipping email and CAD jobs through
--     the existing paths. orders_enqueue_cad (0008) fires on an insert as
--     'paid' and enqueue_cad_jobs_for_order (0016) keys each job on the new
--     order id, so the one-active-job-per-(order, scan) index never collides
--     with the original's jobs. Neither function changes here.
--   - The customer sees it through "orders: select own" (0002) like any other
--     order. No new client policy, no client write path.
--   - It never reaches Stripe: orders_remake_never_charged forbids Stripe ids
--     and a non-zero amount, and every webhook RPC (0013) finds its order by a
--     Stripe id, so no webhook can ever match a remake.
-- A remake reuses the original's scans and their stored measurements: the
-- CAD job reads measurements, never the mesh, so it still works after
-- retention (0004, 0015) has erased the raw scan files.
--
-- paid_at: orders_stamp_paid_at (0015) stamps it on the insert. On a remake
-- it marks when production was authorised, not money received; remake_of
-- and amount_cents = 0 tell the two apart. It also makes the remake live
-- (order_is_live), which pins nothing new: the original pins the same scans.
--
-- The free-text note for reason 'other' is internal, so it is not stored on
-- orders (the customer can read the whole row): it is kept in the audit_log
-- detail of 'order.remake', which has no client policy.
--
-- Idempotency: at most one non-cancelled remake per order
-- (orders_one_open_remake_idx). A repeat call (double click, retry) returns
-- the open remake as 'duplicate' instead of creating a second.
--
-- Exercised by supabase/tests/order_ops_checks.sql.

alter table public.orders
  -- RESTRICT: an order with a remake is a financial record that is never a
  -- dead order (shipped or delivered), so nothing deletes it in practice.
  add column remake_of uuid references public.orders(id) on delete restrict,
  add column remake_reason text
    constraint orders_remake_reason_check check (remake_reason in (
      'fit_too_tight', 'fit_too_loose', 'print_defect',
      'damaged_in_transit', 'wrong_item', 'other'));

alter table public.orders
  add constraint orders_remake_fields_together
    check ((remake_of is null) = (remake_reason is null)),
  add constraint orders_remake_not_self
    check (remake_of is distinct from id),
  add constraint orders_remake_never_charged
    check (remake_of is null or (
      coalesce(amount_cents, 0) = 0
      and stripe_payment_intent is null
      and stripe_checkout_session_id is null));

comment on column public.orders.remake_of is
  'The order this one remakes (0024). Remakes cost 0, carry no Stripe ids and are created paid by create_order_remake only.';
comment on column public.orders.remake_reason is
  'Why the remake was made: fit_too_tight, fit_too_loose, print_defect, damaged_in_transit, wrong_item, other. Set with remake_of.';

create unique index orders_one_open_remake_idx
  on public.orders(remake_of)
  where remake_of is not null and status <> 'cancelled';

-- Lists every remake of an order, cancelled ones included.
create index orders_remake_of_idx on public.orders(remake_of) where remake_of is not null;

-- ---------------------------------------------------------------------------
-- create_order_remake: service role only (the admin panel, after its
-- allowlist + aal2 check). SQLSTATEs follow 0012: 22023 bad input,
-- 23514 refused by current state, P0002 no such order.
-- ---------------------------------------------------------------------------
create function public.create_order_remake(
  p_order_id uuid,
  p_reason text,
  p_note text,
  p_legs text,
  p_actor text
)
returns table (remake_id uuid, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_existing uuid;
  v_left uuid;
  v_right uuid;
  v_id uuid;
begin
  if p_reason is null or p_reason not in (
    'fit_too_tight', 'fit_too_loose', 'print_defect',
    'damaged_in_transit', 'wrong_item', 'other') then
    raise exception 'unknown remake reason' using errcode = 'invalid_parameter_value';
  end if;
  -- 500 matches the admin form (apps/web lib/remake.ts).
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'remake note is longer than 500 characters' using errcode = 'invalid_parameter_value';
  end if;
  if p_reason = 'other' and v_note is null then
    raise exception 'a remake for reason other needs a note' using errcode = 'invalid_parameter_value';
  end if;
  if p_legs is null or p_legs not in ('both', 'left', 'right') then
    raise exception 'legs must be both, left or right' using errcode = 'invalid_parameter_value';
  end if;
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'actor is required' using errcode = 'invalid_parameter_value';
  end if;

  -- Serializes concurrent remakes of the same order, so the duplicate check
  -- below sees a remake committed by a racing call.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;

  select o.id into v_existing
    from public.orders o
    where o.remake_of = p_order_id and o.status <> 'cancelled'
    limit 1;
  if v_existing is not null then
    return query select v_existing, 'duplicate'::text;
    return;
  end if;

  if v_order.status not in ('shipped', 'delivered') then
    raise exception 'only a shipped or delivered order can be remade (status is %)', v_order.status
      using errcode = 'check_violation';
  end if;
  -- Order records outlive accounts (0012). Making new guards for someone who
  -- erased their account would reprocess data they asked us to delete.
  if v_order.user_id is null then
    raise exception 'the customer deleted their account' using errcode = 'check_violation';
  end if;

  v_left := case when p_legs in ('both', 'left') then v_order.scan_id_left end;
  v_right := case when p_legs in ('both', 'right') then v_order.scan_id_right end;
  if v_left is null and v_right is null then
    raise exception 'order % has no % leg', p_order_id, p_legs using errcode = 'invalid_parameter_value';
  end if;

  -- orders_enqueue_cad fires on this insert; if the product lost its CAD
  -- model or a scan has no measurements it raises 23514 and nothing is kept.
  insert into public.orders (
    user_id, product_id, scan_id_left, scan_id_right, status, amount_cents,
    address, remake_of, remake_reason)
  values (
    v_order.user_id, v_order.product_id, v_left, v_right, 'paid', 0,
    v_order.address, v_order.id, p_reason)
  returning id into v_id;

  insert into public.audit_log (actor, action, subject_table, subject_id, detail)
  values
    (p_actor, 'order.remake', 'orders', v_order.id,
      jsonb_build_object('remake_order_id', v_id, 'reason', p_reason, 'legs', p_legs,
        'note', v_note, 'status_at_remake', v_order.status)),
    (p_actor, 'order.remake_created', 'orders', v_id,
      jsonb_build_object('remake_of', v_order.id, 'reason', p_reason, 'legs', p_legs));

  return query select v_id, 'created'::text;
end;
$$;

comment on function public.create_order_remake(uuid, text, text, text, text) is
  'Admin: create a zero-cost paid remake of a shipped or delivered order (same scans, chosen legs), which enqueues its CAD jobs. Returns (remake_id, created | duplicate); an open remake is returned, never doubled. Audited on both orders. Service role only.';

revoke execute on function public.create_order_remake(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.create_order_remake(uuid, text, text, text, text) to service_role;
