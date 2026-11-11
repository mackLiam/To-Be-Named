import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrderStatus } from '@forms/shared';

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

/** A ledger row as refundOrder reads it, with the id it reconciles by. */
export interface LedgerRow extends LedgerRefund {
  stripe_refund_id: string;
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
    list(params: {
      payment_intent: string;
      limit: number;
    }): Promise<{ data: StripeRefund[]; has_more: boolean }>;
  };
}

/** Admin-facing refund messages that are fixed text (admin-messages.ts maps them to codes). */
export const REFUND_MESSAGES = {
  orderNotFound: 'Order not found.',
  notRefundable: 'This order has no refundable payment.',
  nothingLeft: 'Nothing is left to refund on this order.',
  badAmount: 'The refund must be more than 0 and at most the amount left to refund.',
  tooMany: `This order already has ${MAX_REFUNDS_PER_ORDER} refunds. Use the Stripe dashboard.`,
  listFailed:
    'Stripe could not list the refunds already made on this payment, so no new refund was sent. Try again in a minute.',
  reconciled:
    'Stripe had refunds this panel had not recorded. They are recorded now and nothing new was sent. Check the amount left to refund before refunding again.',
  stripeFailed:
    'Stripe did not refund the payment. The Stripe dashboard shows why; nothing was recorded.',
  notRecorded:
    'Stripe made the refund, but this panel did not record it. Submitting a refund again records it from Stripe first and sends no new refund.',
  reconcileFailed:
    'Stripe has a refund on this payment that could not be recorded here, so no new refund was sent. Use the Stripe dashboard.',
  notCancelled:
    'Refund issued, but the order was not cancelled. Cancel it from the status buttons.',
} as const;

/**
 * Stripe refunds on the payment that the ledger does not hold yet, oldest
 * first (Stripe lists newest first). Refunds with no amount are skipped:
 * order_refunds_amount_positive (0025) would refuse them.
 */
export function unrecordedRefunds(
  listed: readonly StripeRefund[],
  ledger: readonly Pick<LedgerRow, 'stripe_refund_id'>[],
): StripeRefund[] {
  const known = new Set(ledger.map((r) => r.stripe_refund_id));
  return listed.filter((r) => !known.has(r.id) && r.amount > 0).reverse();
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
    return { error: REFUND_MESSAGES.orderNotFound };
  }
  const row = order as unknown as OrderForRefund;
  if (!canRefund(row)) {
    return { error: REFUND_MESSAGES.notRefundable };
  }
  const joined = Array.isArray(row.products) ? row.products[0] : row.products;
  const currency = joined?.currency ?? 'usd';

  const { data: ledgerData, error: ledgerError } = await client
    .from('order_refunds')
    .select('seq, amount_cents, stripe_status, stripe_refund_id')
    .eq('order_id', id)
    .order('seq')
    .limit(MAX_REFUNDS_PER_ORDER);
  if (ledgerError) {
    throw ledgerError;
  }
  const ledger = (ledgerData ?? []) as LedgerRow[];

  // Reconcile before choosing an amount or a seq. A refund Stripe made but
  // the ledger lost (the record step failed, or the idempotency key expired
  // after 24 hours) would otherwise leave money "remaining" that was already
  // returned, and a retry would refund it a second time under a new seq.
  let listed: { data: StripeRefund[]; has_more: boolean };
  try {
    listed = await stripe.refunds.list({
      payment_intent: row.stripe_payment_intent!,
      limit: MAX_REFUNDS_PER_ORDER,
    });
  } catch {
    return { error: REFUND_MESSAGES.listFailed };
  }
  if (listed.has_more) {
    return { error: REFUND_MESSAGES.tooMany };
  }
  const missing = unrecordedRefunds(listed.data, ledger);
  for (const lost of missing) {
    const lostSeq = nextRefundSeq(ledger);
    if (lostSeq === null) {
      return { error: REFUND_MESSAGES.tooMany };
    }
    const kind = row.amount_cents != null && lost.amount >= row.amount_cents ? 'full' : 'partial';
    const { error: recordError } = await client.rpc('record_order_refund', {
      p_order_id: id,
      p_seq: lostSeq,
      p_kind: kind,
      p_amount_cents: lost.amount,
      p_stripe_refund_id: lost.id,
      p_stripe_status: lost.status,
      p_actor: actor,
    });
    if (recordError) {
      return { error: REFUND_MESSAGES.reconcileFailed };
    }
    ledger.push({
      seq: lostSeq,
      amount_cents: lost.amount,
      stripe_status: lost.status,
      stripe_refund_id: lost.id,
    });
  }
  // The admin chose the amount against a remaining total that was wrong;
  // stop so they choose again against the corrected one.
  if (missing.length > 0) {
    return { error: REFUND_MESSAGES.reconciled };
  }

  const remaining = refundableRemaining(row, ledger);
  if (remaining <= 0) {
    return { error: REFUND_MESSAGES.nothingLeft };
  }

  const kind = amountCents === undefined ? 'full' : 'partial';
  if (
    kind === 'partial' &&
    (!Number.isInteger(amountCents) || amountCents! < 1 || amountCents! > remaining)
  ) {
    return { error: REFUND_MESSAGES.badAmount };
  }
  const seq = nextRefundSeq(ledger);
  if (seq === null) {
    return { error: REFUND_MESSAGES.tooMany };
  }

  let refund: StripeRefund;
  try {
    refund = await stripe.refunds.create(
      kind === 'full'
        ? { payment_intent: row.stripe_payment_intent! }
        : { payment_intent: row.stripe_payment_intent!, amount: amountCents! },
      { idempotencyKey: refundIdempotencyKey(id, kind, seq) },
    );
  } catch {
    return { error: REFUND_MESSAGES.stripeFailed };
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
    // Money moved. The next attempt's reconcile step records this refund
    // from Stripe's list before it can issue anything new.
    return { error: REFUND_MESSAGES.notRecorded };
  }

  let cancelled = false;
  if (kind === 'full' && (CANCEL_ON_REFUND as readonly string[]).includes(row.status)) {
    const moved = await transitionOrder(client, actor, id, 'cancelled' satisfies OrderStatus);
    if (moved.error) {
      return { error: REFUND_MESSAGES.notCancelled };
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
