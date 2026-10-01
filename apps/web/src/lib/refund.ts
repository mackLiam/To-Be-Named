import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrderStatus } from '@forms/shared';

import { transitionOrder, type WriteResult } from './shop-writes';

/**
 * Admin refund. The Stripe refund is the effect; orders.refunded_at is NOT
 * set here, it is set by the charge.refunded webhook once Stripe confirms,
 * so the column only ever reflects money Stripe says went back.
 */

const CANCEL_ON_REFUND: readonly OrderStatus[] = ['paid', 'in_production'];
const DELIVERED: OrderStatus = 'delivered';

export interface RefundableOrder {
  status: string;
  stripe_payment_intent: string | null;
  refunded_at: string | null;
}

/** Whether the admin page offers "Refund payment". */
export function canRefund(order: RefundableOrder): boolean {
  return Boolean(order.stripe_payment_intent) && !order.refunded_at && order.status !== DELIVERED;
}

export interface RefundStripe {
  refunds: {
    create(
      params: { payment_intent: string },
      options: { idempotencyKey: string },
    ): Promise<{ id: string; status: string | null }>;
  };
}

/**
 * Refund the order's payment in full, audit it, and cancel the order when it
 * has not shipped. The idempotency key makes a double click (or a retry after
 * a lost response) return the same refund instead of issuing a second one.
 */
export async function refundOrder(
  client: SupabaseClient,
  stripe: RefundStripe,
  actor: string,
  id: string,
): Promise<WriteResult> {
  const { data: order, error: readError } = await client
    .from('orders')
    .select('status, stripe_payment_intent, refunded_at')
    .eq('id', id)
    .maybeSingle();
  if (readError) {
    throw readError;
  }
  if (!order) {
    return { error: 'Order not found.' };
  }
  const row = order as RefundableOrder;
  if (!canRefund(row)) {
    return { error: 'This order has no refundable payment.' };
  }

  let refund: { id: string; status: string | null };
  try {
    refund = await stripe.refunds.create(
      { payment_intent: row.stripe_payment_intent! },
      { idempotencyKey: `refund-${id}` },
    );
  } catch (err) {
    // Admin-only surface: Stripe's own reason is what the admin needs to act.
    const reason = err instanceof Error ? err.message : 'unknown error';
    return { error: `Stripe did not refund the payment: ${reason}` };
  }

  const { error: auditError } = await client.from('audit_log').insert({
    actor,
    action: 'order.refund',
    subject_table: 'orders',
    subject_id: id,
    detail: {
      payment_intent: row.stripe_payment_intent,
      refund_id: refund.id,
      refund_status: refund.status,
      status_at_refund: row.status,
    },
  });
  if (auditError) {
    throw auditError;
  }

  if ((CANCEL_ON_REFUND as readonly string[]).includes(row.status)) {
    const moved = await transitionOrder(client, actor, id, 'cancelled' satisfies OrderStatus);
    if (moved.error) {
      return { error: `Refund issued, but the order was not cancelled: ${moved.error}` };
    }
  }
  return { error: null };
}
