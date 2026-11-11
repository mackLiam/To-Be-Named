import { describe, expect, it } from 'vitest';

import { toTimeline } from './timeline';
import type { TimelineRow } from './types';

const R = '00000000-0000-4000-8000-0000000000a8';

function audit(action: string, detail: Record<string, unknown> | null, id = 1): TimelineRow {
  return {
    source: 'audit',
    entry_id: id,
    actor: 'admin@x',
    action,
    detail,
    body: null,
    created_at: '2026-07-01T00:00:00Z',
  };
}

const one = (row: TimelineRow) => toTimeline([row], 'usd')[0]!;

describe('toTimeline', () => {
  it('shows notes with their body and a stable key per source', () => {
    const entries = toTimeline(
      [
        { ...audit('order.note', null, 5), source: 'note', body: 'Called them.' },
        audit('order.status', { from: 'paid', to: 'in_production' }, 5),
      ],
      'usd',
    );
    expect(entries.map((e) => [e.key, e.kind, e.body])).toEqual([
      ['note-5', 'note', 'Called them.'],
      ['audit-5', 'status', null],
    ]);
    expect(entries[1]!.text).toBe('Paid to In production');
  });

  it('describes refunds with amounts, and the Stripe total', () => {
    expect(
      one(
        audit('order.refund', { amount_cents: 2500, kind: 'partial', refund_status: 'succeeded' }),
      ).text,
    ).toBe('Partial refund of $25.00 issued (succeeded)');
    expect(one(audit('order.refund', { amount_cents: 17800, kind: 'full' })).text).toBe(
      'Refund of $178.00 issued',
    );
    expect(one(audit('order.refund', { refund_status: 'pending' })).text).toBe(
      'Refund issued (pending)',
    );
    expect(
      one(audit('stripe.charge.refunded', { fully_refunded: true, amount_refunded_cents: 17800 }))
        .text,
    ).toBe('Stripe reported a full refund, $178.00 refunded in total');
    expect(one(audit('stripe.charge.refunded', { fully_refunded: false })).text).toBe(
      'Stripe reported a refund',
    );
  });

  it('links remakes both ways and includes the internal note', () => {
    const made = one(
      audit('order.remake', { remake_order_id: R, reason: 'other', note: 'Strap tore.' }),
    );
    expect(made).toMatchObject({
      kind: 'remake',
      text: 'Remake created: Other. Strap tore.',
      orderLink: R,
    });
    expect(
      one(audit('order.remake_created', { remake_of: R, reason: 'fit_too_tight' })),
    ).toMatchObject({
      text: 'Created as a remake: Fit too tight',
      orderLink: R,
    });
  });

  it('describes emails sent and not sent', () => {
    expect(one(audit('order.email', { template: 'refund_issued', sent: true })).text).toBe(
      'Email sent: refund issued',
    );
    expect(
      one(
        audit('order.email', {
          template: 'order_cancelled',
          sent: false,
          reason: 'not_configured',
        }),
      ).text,
    ).toBe('Email not sent: order cancelled (email is not configured)');
  });

  it('describes payments and falls back to the action name', () => {
    expect(one(audit('stripe.checkout.session.completed', { needs_refund: true })).text).toBe(
      'Payment received after cancellation',
    );
    expect(one(audit('stripe.checkout.session.expired', {})).text).toBe('Checkout expired');
    expect(one(audit('order_purged_with_scan', null))).toMatchObject({
      kind: 'other',
      text: 'order_purged_with_scan',
    });
  });
});
