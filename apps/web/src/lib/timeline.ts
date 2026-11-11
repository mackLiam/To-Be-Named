/**
 * Order timeline wording (admin order page). Pure: rows come from
 * admin_order_timeline (migration 0026), which merges audit_log and
 * order_notes newest first. Anything not listed here falls back to
 * describeAudit, so a new audit action still renders.
 */

import { formatMoney } from './money';
import { remakeReasonLabel } from './remake';
import { describeAudit } from './shop';
import type { TimelineRow } from './types';

export type TimelineKind =
  'note' | 'status' | 'refund' | 'remake' | 'email' | 'payment' | 'shipping' | 'other';

export interface TimelineEntry {
  key: string;
  at: string;
  kind: TimelineKind;
  text: string;
  actor: string;
  /** Note body, shown as written. */
  body: string | null;
  /** A related order (the remake, or the order remade). */
  orderLink: string | null;
}

export const TIMELINE_KIND_LABEL: Record<TimelineKind, string> = {
  note: 'Note',
  status: 'Status',
  refund: 'Refund',
  remake: 'Remake',
  email: 'Email',
  payment: 'Payment',
  shipping: 'Shipping',
  other: 'Other',
};

const EMAIL_LABEL: Record<string, string> = {
  order_shipped: 'shipped',
  order_cancelled: 'order cancelled',
  refund_issued: 'refund issued',
  remake_started: 'remake started',
  rescan_needed: 'rescan needed',
};

const EMAIL_REASON: Record<string, string> = {
  not_configured: 'email is not configured',
  provider_error: 'the email provider failed',
  lookup_failed: 'no address for the customer',
  not_applicable: 'not needed for this order',
};

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function describe(
  row: TimelineRow,
  currency: string | null,
): { kind: TimelineKind; text: string; orderLink: string | null } {
  const d = row.detail ?? {};
  switch (row.action) {
    case 'order.note':
      return { kind: 'note', text: 'Note', orderLink: null };
    case 'order.status':
      return { kind: 'status', text: describeAudit(row), orderLink: null };
    case 'order.tracking':
      return { kind: 'shipping', text: describeAudit(row), orderLink: null };
    case 'order.refund': {
      const amount = num(d.amount_cents);
      const status = str(d.refund_status);
      const kind = str(d.kind);
      const text =
        amount === null
          ? describeAudit(row)
          : `${kind === 'partial' ? 'Partial refund' : 'Refund'} of ${formatMoney(amount, currency)} issued${status ? ` (${status})` : ''}`;
      return { kind: 'refund', text, orderLink: null };
    }
    case 'stripe.charge.refunded': {
      const total = num(d.amount_refunded_cents);
      const full = d.fully_refunded === true;
      const text = `Stripe reported ${full ? 'a full refund' : 'a refund'}${total === null ? '' : `, ${formatMoney(total, currency)} refunded in total`}`;
      return { kind: 'refund', text, orderLink: null };
    }
    case 'order.remake': {
      const id = str(d.remake_order_id);
      const note = str(d.note);
      return {
        kind: 'remake',
        text: `Remake created: ${remakeReasonLabel(str(d.reason))}${note ? `. ${note}` : ''}`,
        orderLink: id,
      };
    }
    case 'order.remake_created': {
      const id = str(d.remake_of);
      return {
        kind: 'remake',
        text: `Created as a remake: ${remakeReasonLabel(str(d.reason))}`,
        orderLink: id,
      };
    }
    case 'order.email': {
      const template = EMAIL_LABEL[str(d.template) ?? ''] ?? str(d.template) ?? 'unknown';
      if (d.sent === true) {
        return { kind: 'email', text: `Email sent: ${template}`, orderLink: null };
      }
      const reason = EMAIL_REASON[str(d.reason) ?? ''] ?? str(d.reason) ?? 'unknown reason';
      return { kind: 'email', text: `Email not sent: ${template} (${reason})`, orderLink: null };
    }
    case 'stripe.checkout.session.completed':
      return {
        kind: 'payment',
        text: d.needs_refund === true ? 'Payment received after cancellation' : 'Payment received',
        orderLink: null,
      };
    case 'stripe.checkout.session.expired':
      return { kind: 'payment', text: 'Checkout expired', orderLink: null };
    default:
      return { kind: 'other', text: describeAudit(row), orderLink: null };
  }
}

export function toTimeline(rows: readonly TimelineRow[], currency: string | null): TimelineEntry[] {
  return rows.map((row) => {
    const { kind, text, orderLink } = describe(row, currency);
    return {
      key: `${row.source}-${row.entry_id}`,
      at: row.created_at,
      kind,
      text,
      actor: row.actor,
      body: row.source === 'note' ? row.body : null,
      orderLink,
    };
  });
}
