import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrderStatus } from '@forms/shared';

import { formatMoney } from './money';
import { transitionOrder } from './shop-writes';

/**
 * Admin refunds, full or partial. The Stripe refund is the effect;
 * orders.refunded_at is NOT set here, it is set by the charge.refunded webhook
 * once Stripe confirms, so the column only ever reflects money Stripe says
 * went back.
 *
 * Refunded so far = the larger of the admin ledger (order_refunds, 0025) and
 * Stripe's cumulative total from the webhook (orders.stripe_refunded_cents).
 * Never their sum: the Stripe total already contains the admin refunds.
 *
 * TODO(liam): when a refund (full or partial) is offered at all. Delivered
 * orders are refunded in the Stripe dashboard only, as before; the webhook
 * still records the amount.
 */

const CANCEL_ON_REFUND: readonly OrderStatus[] = ['paid', 'in_production'];
const DELIVERED: OrderStatus = 'delivered';

/** order_refunds_seq_range (0025). */
export const MAX_REFUNDS_PER_ORDER = 100;

/** Stripe refund states that returned no money. */
const NOT_REFUNDED = ['failed', 'canceled'];

export interface RefundableOrder {
  status: string;
  stripe_payment_intent: string | null;
  refunded_at: string | null;
}

export interface RefundAmounts {
  amount_cents: number | null;
  stripe_refunded_cents: number | null;
}

export interface LedgerRefund {
  seq: number;
  amount_cents: number;
  stripe_status: string | null;
}

/** Whether the admin page offers refunds at all. */
export function canRefund(order: RefundableOrder): boolean {
  return Boolean(order.stripe_payment_intent) && !order.refunded_at && order.status !== DELIVERED;
}

export function refundedSoFar(order: RefundAmounts, ledger: readonly LedgerRefund[]): number {
  const ledgerSum = ledger
    .filter((r) => !NOT_REFUNDED.includes(r.stripe_status ?? ''))
    .reduce((sum, r) => sum + r.amount_cents, 0);
  return Math.max(ledgerSum, order.stripe_refunded_cents ?? 0);
}

/** Cents still refundable; 0 when nothing is. */
export function refundableRemaining(
  order: RefundableOrder & RefundAmounts,
  ledger: readonly LedgerRefund[],
): number {
  if (!canRefund(order) || order.amount_cents == null) {
    return 0;
  }
  return Math.max(0, order.amount_cents - refundedSoFar(order, ledger));
}

export interface RefundPanelState {
  /** Offer the refund form at all. */
  offer: boolean;
  remainingCents: number;
  refundedCents: number;
  /** A full refund also cancels the order (paid or in production). */
  fullCancels: boolean;
}

export function refundPanelState(
  order: RefundableOrder & RefundAmounts,
  ledger: readonly LedgerRefund[],
): RefundPanelState {
  const remainingCents = refundableRemaining(order, ledger);
  return {
    offer: remainingCents > 0,
    remainingCents,
    refundedCents: refundedSoFar(order, ledger),
    fullCancels: (CANCEL_ON_REFUND as readonly string[]).includes(order.status),
  };
}

/** Next ledger seq, or null once the per-order cap is reached. */
export function nextRefundSeq(ledger: readonly LedgerRefund[]): number | null {
  const next = ledger.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
  return next > MAX_REFUNDS_PER_ORDER ? null : next;
}

/**
 * Stripe idempotency key. The full refund keeps the key it always had; each
 * partial refund is keyed by its ledger seq, so a double click or a retry
 * after a lost response gets the same Stripe refund back instead of a second.
 */
export function refundIdempotencyKey(
  orderId: string,
  kind: 'full' | 'partial',
  seq: number,
): string {
  return kind === 'full' ? `refund-${orderId}` : `refund-${orderId}-${seq}`;
}

export interface StripeRefund {
  id: string;
  status: string | null;
  amount: number;
}

export interface RefundStripe {
  refunds: {
    create(
      params: { payment_intent: string; amount?: number },
      options: { idempotencyKey: string },
    ): Promise<StripeRefund>;
  };
}

export interface IssuedRefund {
  amountCents: number;
  currency: string;
  kind: 'full' | 'partial';
  /** False when this exact Stripe refund was already recorded (a repeat). */
  recorded: boolean;
  /** The refund also cancelled the order. */
  cancelled: boolean;
}

export type RefundResult =
  { error: string; refund?: undefined } | { error: null; refund: IssuedRefund };

interface OrderForRefund extends RefundableOrder, RefundAmounts {
  products: { currency: string } | { currency: string }[] | null;
}

/**
 * Refund the order's payment: in full when amountCents is undefined (the
 * rest of the charge, cancelling a paid or in-production order), otherwise
 * that many cents, from 1 to the remaining refundable amount, leaving the
 * status alone.
 */
export async function refundOrder(
  client: SupabaseClient,
  stripe: RefundStripe,
  actor: string,
  id: string,
  amountCents?: number,
): Promise<RefundResult> {
  const { data: order, error: readError } = await client
    .from('orders')
    .select(
      'status, stripe_payment_intent, refunded_at, amount_cents, stripe_refunded_cents, products(currency)',
    )
    .eq('id', id)
    .maybeSingle();
  if (readError) {
    throw readError;
  }
  if (!order) {
    return { error: 'Order not found.' };
  }
  const row = order as unknown as OrderForRefund;
  if (!canRefund(row)) {
    return { error: 'This order has no refundable payment.' };
  }
  const joined = Array.isArray(row.products) ? row.products[0] : row.products;
  const currency = joined?.currency ?? 'usd';

  const { data: ledgerData, error: ledgerError } = await client
    .from('order_refunds')
    .select('seq, amount_cents, stripe_status')
    .eq('order_id', id)
    .order('seq')
    .limit(MAX_REFUNDS_PER_ORDER);
  if (ledgerError) {
    throw ledgerError;
  }
  const ledger = (ledgerData ?? []) as LedgerRefund[];
  const remaining = refundableRemaining(row, ledger);
  if (remaining <= 0) {
    return { error: 'Nothing is left to refund on this order.' };
  }

  const kind = amountCents === undefined ? 'full' : 'partial';
  if (
    kind === 'partial' &&
    (!Number.isInteger(amountCents) || amountCents! < 1 || amountCents! > remaining)
  ) {
    return {
      error: `The refund must be from ${formatMoney(1, currency)} to ${formatMoney(remaining, currency)}, the amount left to refund.`,
    };
  }
  const seq = nextRefundSeq(ledger);
  if (seq === null) {
    return {
      error: `This order already has ${MAX_REFUNDS_PER_ORDER} refunds. Use the Stripe dashboard.`,
    };
  }

  let refund: StripeRefund;
  try {
    refund = await stripe.refunds.create(
      kind === 'full'
        ? { payment_intent: row.stripe_payment_intent! }
        : { payment_intent: row.stripe_payment_intent!, amount: amountCents! },
      { idempotencyKey: refundIdempotencyKey(id, kind, seq) },
    );
  } catch (err) {
    // Admin-only surface: Stripe's own reason is what the admin needs to act.
    const reason = err instanceof Error ? err.message : 'unknown error';
    return { error: `Stripe did not refund the payment: ${reason}` };
  }
  const refundedCents = refund.amount > 0 ? refund.amount : (amountCents ?? remaining);

  // Ledger and audit row in one transaction (0025).
  const { data: outcome, error: recordError } = await client.rpc('record_order_refund', {
    p_order_id: id,
    p_seq: seq,
    p_kind: kind,
    p_amount_cents: refundedCents,
    p_stripe_refund_id: refund.id,
    p_stripe_status: refund.status,
    p_actor: actor,
  });
  if (recordError) {
    // Money moved. A retry with the same amount reuses the idempotency key,
    // gets this refund back from Stripe, and records it.
    return {
      error: `Stripe refunded ${formatMoney(refundedCents, currency)} (${refund.id}), but it was not recorded: ${recordError.message}. Retry the same refund to record it; it will not be charged twice.`,
    };
  }

  let cancelled = false;
  if (kind === 'full' && (CANCEL_ON_REFUND as readonly string[]).includes(row.status)) {
    const moved = await transitionOrder(client, actor, id, 'cancelled' satisfies OrderStatus);
    if (moved.error) {
      return { error: `Refund issued, but the order was not cancelled: ${moved.error}` };
    }
    cancelled = true;
  }
  return {
    error: null,
    refund: {
      amountCents: refundedCents,
      currency,
      kind,
      recorded: outcome === 'recorded',
      cancelled,
    },
  };
}
