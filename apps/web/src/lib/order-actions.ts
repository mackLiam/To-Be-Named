import type { SupabaseClient } from '@supabase/supabase-js';

import {
  emailAuditDetail,
  notifyOrderCancelled,
  notifyOrderShipped,
  notifyRefundIssued,
  notifyRemakeStarted,
  type EmailDeps,
  type EmailResult,
  type EmailTemplate,
} from './email';
import { isUuid } from './ids';
import { parseMoneyAmount } from './money';
import { addOrderNote, parseNoteForm } from './order-notes';
import { refundOrder, type RefundStripe } from './refund';
import { createRemake, parseRemakeForm } from './remake';

/**
 * Order support actions (remake, refund, note) without the framework, so the
 * whole sequence is unit tested: admin gate first, then input, then the write
 * and its email. app/admin/actions.ts supplies requireAdmin, the service role
 * client and Stripe, and turns the outcome into a redirect.
 */

export interface AdminWriter {
  client: SupabaseClient;
  actor: string;
}

export interface OrderActionDeps {
  /**
   * The server-side admin gate (allowlist + aal2). Throws for anyone else
   * (404 or the MFA redirect); null means allowed but read-only (fake mode or
   * no service role). Runs before any input is read.
   */
  authorize(): Promise<AdminWriter | null>;
  email: EmailDeps;
}

export interface ActionOutcome {
  path: string;
  error: string | null;
  notice: string | null;
}

export const READ_ONLY = 'Read-only: no service role is configured, so changes cannot be saved.';

/** Success notices (admin-messages.ts maps them to codes). */
export const ORDER_NOTICES = {
  remakeCreated: 'Remake created. Its CAD jobs are queued from the original scans.',
  remakeExisting: 'This order already had an open remake. Showing it instead of making a second.',
  refundIssued: 'Refund issued.',
  refundRepeat: 'This refund was already issued and recorded.',
  noteAdded: 'Note added.',
} as const;

function orderPath(id: string | undefined): string {
  return id && isUuid(id) ? `/admin/orders/${id.toLowerCase()}` : '/admin/orders';
}

function fail(path: string, error: string): ActionOutcome {
  return { path, error, notice: null };
}

/**
 * Record an email attempt in the order's audit trail (the timeline shows
 * it). Best effort: the action's real effect is already committed.
 */
export async function auditEmail(
  w: AdminWriter,
  orderId: string,
  template: EmailTemplate,
  result: EmailResult,
): Promise<void> {
  try {
    await w.client.from('audit_log').insert({
      actor: w.actor,
      action: 'order.email',
      subject_table: 'orders',
      subject_id: orderId,
      detail: emailAuditDetail(template, result),
    });
  } catch {
    // An audit failure for an email must not report the committed action as failed.
  }
}

export async function remakeOrderAction(
  deps: OrderActionDeps,
  form: Record<string, string | undefined>,
): Promise<ActionOutcome> {
  const w = await deps.authorize();
  const path = orderPath(form.id);
  const parsed = parseRemakeForm(form);
  if (!parsed.ok) {
    return fail(path, parsed.errors.join(' '));
  }
  if (!w) {
    return fail(path, READ_ONLY);
  }
  const result = await createRemake(w.client, w.actor, parsed.value);
  if (result.error !== null) {
    return fail(path, result.error);
  }
  if (result.created) {
    const sent = await notifyRemakeStarted(w.client, result.remakeId, deps.email);
    await auditEmail(w, result.remakeId, 'remake_started', sent);
  }
  return {
    path: orderPath(result.remakeId),
    error: null,
    notice: result.created ? ORDER_NOTICES.remakeCreated : ORDER_NOTICES.remakeExisting,
  };
}

export async function refundOrderAction(
  deps: OrderActionDeps & { stripe(): RefundStripe | null },
  form: Record<string, string | undefined>,
): Promise<ActionOutcome> {
  const w = await deps.authorize();
  const id = form.id ?? '';
  if (!isUuid(id)) {
    return fail('/admin/orders', 'Unknown order.');
  }
  const path = orderPath(id);
  // No default: a form that lost its mode must not become a full refund.
  const mode = form.mode;
  if (mode !== 'full' && mode !== 'partial') {
    return fail(path, 'Choose a full or a partial refund.');
  }
  let amountCents: number | undefined;
  if (mode === 'partial') {
    const parsed = parseMoneyAmount(form.amount);
    if (parsed === null || parsed < 1) {
      return fail(path, 'Enter the refund amount, for example 12.50.');
    }
    amountCents = parsed;
  }
  if (!w) {
    return fail(path, READ_ONLY);
  }
  const stripe = deps.stripe();
  if (!stripe) {
    return fail(path, 'Refunds are unavailable: STRIPE_SECRET_KEY is not configured.');
  }
  const result = await refundOrder(w.client, stripe, w.actor, id.toLowerCase(), amountCents);
  if (result.error !== null) {
    return fail(path, result.error);
  }
  const { refund } = result;
  // A repeat of an already recorded refund has already been emailed.
  if (refund.recorded) {
    const sent = await notifyRefundIssued(
      w.client,
      id.toLowerCase(),
      {
        amountCents: refund.amountCents,
        currency: refund.currency,
        full: refund.kind === 'full',
        cancelled: refund.cancelled,
      },
      deps.email,
    );
    await auditEmail(w, id.toLowerCase(), 'refund_issued', sent);
  }
  return {
    path,
    error: null,
    notice: refund.recorded ? ORDER_NOTICES.refundIssued : ORDER_NOTICES.refundRepeat,
  };
}

export async function addOrderNoteAction(
  deps: OrderActionDeps,
  form: Record<string, string | undefined>,
): Promise<ActionOutcome> {
  const w = await deps.authorize();
  const path = orderPath(form.id);
  const parsed = parseNoteForm(form);
  if (!parsed.ok) {
    return fail(path, parsed.errors.join(' '));
  }
  if (!w) {
    return fail(path, READ_ONLY);
  }
  const result = await addOrderNote(w.client, w.actor, parsed.value);
  return result.error
    ? fail(path, result.error)
    : { path, error: null, notice: ORDER_NOTICES.noteAdded };
}

/**
 * Emails after a successful admin status move: shipped, and cancelled (which
 * notifyOrderCancelled skips for an order that was never paid). Best effort:
 * the notifiers never throw, and a missed email never undoes the move.
 */
export async function afterStatusChange(
  w: AdminWriter,
  orderId: string,
  to: string,
  email: EmailDeps,
): Promise<void> {
  if (to === 'shipped') {
    await auditEmail(
      w,
      orderId,
      'order_shipped',
      await notifyOrderShipped(w.client, orderId, email),
    );
  } else if (to === 'cancelled') {
    const sent = await notifyOrderCancelled(w.client, orderId, email);
    if (sent.sent || sent.reason !== 'not_applicable') {
      await auditEmail(w, orderId, 'order_cancelled', sent);
    }
  }
}
