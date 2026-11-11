-- 0025_order_refunds.sql
-- Partial refunds from the admin panel, with a ledger so the remaining
-- refundable amount stays right across several of them. docs/BUSINESS-GAPS.md
-- rank 6, docs/DESIGN.md sections 8 and 9.7.
--
-- Two sources, never added together:
--   - order_refunds: one row per refund the admin panel issued, recorded after
--     Stripe accepted it (record_order_refund). seq numbers the order's
--     refunds; the panel derives the Stripe idempotency key from (order, seq),
--     so a double click or a retry gets Stripe's original refund back and
--     lands on the existing row ('duplicate').
--   - orders.stripe_refunded_cents: Stripe's own cumulative total for the
--     charge (charge.amount_refunded), stored by the charge.refunded webhook.
--     It already includes the admin refunds, and also dashboard refunds the
--     ledger never sees.
-- Refunded so far = greatest(ledger sum, stripe_refunded_cents). Taking the
-- larger, not the sum, is what keeps the two paths from double counting.
-- Stripe remains the final guard: it refuses any refund above the charge.
--
-- stripe_charge_refunded_amount replaces stripe_charge_refunded (0013) as the
-- webhook's RPC. 0013's function is left in place, unchanged, so a web deploy
-- and this migration can land in either order.
--
-- Exercised by supabase/tests/order_ops_checks.sql.

alter table public.orders
  add column stripe_refunded_cents integer
    constraint orders_stripe_refunded_cents_check check (stripe_refunded_cents >= 0);

comment on column public.orders.stripe_refunded_cents is
  'Cumulative amount Stripe reported refunded on this order''s charge (charge.refunded webhook, 0025). A high-water mark: a late or replayed event never lowers it. Null until the first refund event.';

-- ---------------------------------------------------------------------------
-- order_refunds: admin-issued refunds. Service role only, append-only.
-- ---------------------------------------------------------------------------
create table public.order_refunds (
  id bigint generated always as identity primary key,
  -- RESTRICT: a refund is a financial record. Only dead orders (never paid,
  -- so never refunded) are ever deleted (0015 purge_scan_row).
  order_id uuid not null references public.orders(id) on delete restrict,
  -- Bounds the per-order ledger read in the admin panel.
  seq integer not null constraint order_refunds_seq_range check (seq between 1 and 100),
  kind text not null constraint order_refunds_kind_check check (kind in ('full', 'partial')),
  amount_cents integer not null constraint order_refunds_amount_positive check (amount_cents > 0),
  stripe_refund_id text not null
    constraint order_refunds_stripe_refund_id_shape
      check (stripe_refund_id ~ '^[a-z]+_[A-Za-z0-9]+$' and char_length(stripe_refund_id) <= 255),
  stripe_status text
    constraint order_refunds_stripe_status_length
      check (stripe_status is null or char_length(stripe_status) between 1 and 40),
  actor text not null constraint order_refunds_actor_length check (char_length(actor) between 1 and 320),
  created_at timestamptz not null default now(),
  constraint order_refunds_order_seq_uq unique (order_id, seq),
  constraint order_refunds_stripe_refund_id_uq unique (stripe_refund_id)
);

comment on table public.order_refunds is
  'Refunds issued from the admin panel (0025), one row per Stripe refund. Written only by record_order_refund. No client access; append-only for the service role.';

alter table public.order_refunds enable row level security;
revoke all on public.order_refunds from anon, authenticated;
-- Append-only: the ledger is a record, corrections are new rows. Referential
-- actions run as the table owner, so this does not block anything.
revoke update, delete, truncate on public.order_refunds from service_role;

-- ---------------------------------------------------------------------------
-- record_order_refund: ledger row + audit row in one transaction.
-- Returns 'recorded' | 'duplicate'.
-- ---------------------------------------------------------------------------
create function public.record_order_refund(
  p_order_id uuid,
  p_seq integer,
  p_kind text,
  p_amount_cents integer,
  p_stripe_refund_id text,
  p_stripe_status text,
  p_actor text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_seq integer := p_seq;
begin
  if nullif(btrim(coalesce(p_actor, '')), '') is null then
    raise exception 'actor is required' using errcode = 'invalid_parameter_value';
  end if;

  -- Serializes refunds of one order, so the seq and duplicate checks below
  -- see rows committed by a racing call.
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    raise exception 'order % not found', p_order_id using errcode = 'no_data_found';
  end if;
  if v_order.stripe_payment_intent is null then
    raise exception 'order % has no Stripe payment', p_order_id using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.order_refunds where stripe_refund_id = p_stripe_refund_id) then
    return 'duplicate';
  end if;

  -- A different refund already holds this seq (two keys raced, for example a
  -- full and a partial refund at once, and Stripe accepted both): record it
  -- after the others instead of losing it.
  if exists (select 1 from public.order_refunds where order_id = p_order_id and seq = p_seq) then
    select max(seq) + 1 into v_seq from public.order_refunds where order_id = p_order_id;
  end if;

  insert into public.order_refunds
    (order_id, seq, kind, amount_cents, stripe_refund_id, stripe_status, actor)
  values
    (p_order_id, v_seq, p_kind, p_amount_cents, p_stripe_refund_id, p_stripe_status, p_actor);

  insert into public.audit_log (actor, action, subject_table, subject_id, detail)
  values (p_actor, 'order.refund', 'orders', p_order_id,
    jsonb_build_object(
      'payment_intent', v_order.stripe_payment_intent,
      'refund_id', p_stripe_refund_id,
      'refund_status', p_stripe_status,
      'status_at_refund', v_order.status,
      'kind', p_kind,
      'amount_cents', p_amount_cents,
      'seq', v_seq));

  return 'recorded';
end;
$$;

comment on function public.record_order_refund(uuid, integer, text, integer, text, text, text) is
  'Admin: record a refund Stripe accepted (ledger row + audit row, one transaction). Idempotent on the Stripe refund id. Service role only.';

revoke execute on function public.record_order_refund(uuid, integer, text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.record_order_refund(uuid, integer, text, integer, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- stripe_charge_refunded_amount: 0013 stripe_charge_refunded plus Stripe's
-- cumulative refunded amount. Same ledger, same 'applied' | 'duplicate' |
-- 'ignored' contract, status still never changed by a webhook.
-- ---------------------------------------------------------------------------
create function public.stripe_charge_refunded_amount(
  p_event_id text,
  p_payment_intent text,
  p_fully_refunded boolean,
  p_amount_refunded_cents integer
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_outcome text;
begin
  insert into public.stripe_events (id, type)
  values (p_event_id, 'charge.refunded')
  on conflict (id) do nothing;
  if not found then
    return 'duplicate';
  end if;

  select * into v_order
    from public.orders
    where stripe_payment_intent = p_payment_intent
    for update;

  if found then
    update public.orders
      set refunded_at = case when p_fully_refunded then coalesce(refunded_at, now()) else refunded_at end,
          -- Events can arrive out of order; the total only ever grows.
          stripe_refunded_cents = case
            when p_amount_refunded_cents is null or p_amount_refunded_cents < 0 then stripe_refunded_cents
            else greatest(coalesce(stripe_refunded_cents, 0), p_amount_refunded_cents)
          end
      where id = v_order.id;
    v_outcome := 'applied';
  else
    v_outcome := 'ignored';
  end if;

  insert into public.audit_log (actor, action, subject_table, subject_id, detail)
  values ('stripe-webhook', 'stripe.charge.refunded', 'orders', v_order.id,
    jsonb_build_object(
      'event_id', p_event_id,
      'outcome', v_outcome,
      'payment_intent', p_payment_intent,
      'fully_refunded', p_fully_refunded,
      'amount_refunded_cents', p_amount_refunded_cents,
      'order_status', v_order.status));

  return v_outcome;
end;
$$;

comment on function public.stripe_charge_refunded_amount(text, text, boolean, integer) is
  'Webhook: charge.refunded. Idempotent on p_event_id. Full refund stamps refunded_at; the cumulative refunded amount is kept as a high-water mark. Never changes status. Service role only.';

revoke execute on function public.stripe_charge_refunded_amount(text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.stripe_charge_refunded_amount(text, text, boolean, integer) to service_role;
