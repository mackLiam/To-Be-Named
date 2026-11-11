import { describe, expect, it, vi } from 'vitest';

import {
  emailAuditDetail,
  notifyOrderCancelled,
  notifyRefundIssued,
  notifyRemakeStarted,
  notifyRescanNeeded,
  orderCancelledEmail,
  refundIssuedEmail,
  remakeStartedEmail,
  rescanNeededEmail,
  type EmailDeps,
} from './email';

const ORDER = 'abcdef12-0000-4000-8000-000000000001';
const ORIGINAL = '12345678-0000-4000-8000-000000000002';

function deps(over: Partial<EmailDeps> = {}): EmailDeps {
  return {
    fetch: vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never,
    apiKey: 'rk_secret',
    from: 'FORMS <orders@example.test>',
    ...over,
  };
}

function sentBody(d: EmailDeps): { to: string; subject: string; text: string } {
  const call = (d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
    string,
    { body: string },
  ];
  return JSON.parse(call[1].body);
}

// U+2013 and U+2014, written as escapes so this file holds no dash characters.
const BANNED = new RegExp('[\\u2013\\u2014]|\\p{Extended_Pictographic}', 'u');
// Words that would make a promise about timing or policy.
const PROMISES = /\b(days?|hours?|weeks?|guarantee|within|policy|eligible|free of charge)\b/i;

describe('support email templates', () => {
  const all = [
    refundIssuedEmail({
      orderId: ORDER,
      amountCents: 2500,
      currency: 'usd',
      full: false,
      cancelled: false,
    }),
    refundIssuedEmail({
      orderId: ORDER,
      amountCents: 17800,
      currency: 'usd',
      full: true,
      cancelled: true,
    }),
    orderCancelledEmail({ orderId: ORDER, productName: 'Pro Guard' }),
    remakeStartedEmail({ orderId: ORDER, originalOrderId: ORIGINAL, productName: 'Pro Guard' }),
    rescanNeededEmail({ orderId: ORDER }),
    rescanNeededEmail(),
  ];

  it('are plain text, short, with no dashes, emojis or timing and policy promises', () => {
    for (const { subject, text } of all) {
      expect(subject).not.toMatch(BANNED);
      expect(text).not.toMatch(BANNED);
      expect(text).not.toMatch(PROMISES);
      expect(text).not.toMatch(/<[a-z]/i);
      expect(text.length).toBeLessThan(500);
      expect(text).toContain('Replies to this email reach our support team.');
    }
  });

  it('refund email states the amount and whether it was full or partial', () => {
    const partial = all[0]!;
    expect(partial.subject).toBe('FORMS order ABCDEF12: refund issued');
    expect(partial.text).toContain('partial refund of $25.00 for order ABCDEF12');
    expect(partial.text).not.toContain('cancelled');
    const full = all[1]!;
    expect(full.text).toContain('refunded your payment of $178.00');
    expect(full.text).toContain('Your order has been cancelled.');
  });

  it('cancelled email makes no statement about refunds', () => {
    const { subject, text } = all[2]!;
    expect(subject).toBe('FORMS order ABCDEF12 cancelled');
    expect(text).toContain('Your order ABCDEF12 for Pro Guard has been cancelled.');
    expect(text).not.toMatch(/refund/i);
  });

  it('remake email names both references', () => {
    const { subject, text } = all[3]!;
    expect(subject).toBe('FORMS order 12345678: we are making a replacement');
    expect(text).toContain('replacement Pro Guard for your order 12345678');
    expect(text).toContain('its own order reference, ABCDEF12');
  });

  it('rescan email mentions the order only when given one', () => {
    expect(all[4]!.text).toContain('your order ABCDEF12');
    expect(all[5]!.text).not.toContain('order ');
    expect(all[5]!.subject).toBe('FORMS: please scan again');
  });
});

type OrderData = {
  id: string;
  user_id: string | null;
  paid_at: string | null;
  remake_of: string | null;
  products: { name: string } | null;
};

function client(order: OrderData | null, email: string | null = 'c@example.test') {
  const getUserById = vi.fn().mockResolvedValue({ data: { user: { email } }, error: null });
  const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: order, error: null }) }));
  return {
    getUserById,
    eq,
    c: {
      from: () => ({ select: () => ({ eq }) }),
      auth: { admin: { getUserById } },
    } as never,
  };
}

const order: OrderData = {
  id: ORDER,
  user_id: 'u1',
  paid_at: '2026-07-01T00:00:00Z',
  remake_of: null,
  products: { name: 'Pro Guard' },
};

describe('support notifiers', () => {
  it('refund: looks up the order and sends to the customer', async () => {
    const d = deps();
    const { c, eq } = client(order);
    expect(
      await notifyRefundIssued(
        c,
        ORDER,
        { amountCents: 500, currency: 'usd', full: false, cancelled: false },
        d,
      ),
    ).toEqual({ sent: true });
    expect(eq).toHaveBeenCalledWith('id', ORDER);
    const body = sentBody(d);
    expect(body.to).toBe('c@example.test');
    expect(body.text).toContain('$5.00');
  });

  it('cancelled: skips an order that was never paid', async () => {
    const d = deps();
    const { c, getUserById } = client({ ...order, paid_at: null });
    expect(await notifyOrderCancelled(c, ORDER, d)).toEqual({
      sent: false,
      reason: 'not_applicable',
    });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(getUserById).not.toHaveBeenCalled();
    expect(await notifyOrderCancelled(client(order).c, ORDER, deps())).toEqual({ sent: true });
  });

  it('remake: needs a remake order', async () => {
    const d = deps();
    expect(await notifyRemakeStarted(client(order).c, ORDER, d)).toEqual({
      sent: false,
      reason: 'not_applicable',
    });
    expect(
      await notifyRemakeStarted(client({ ...order, remake_of: ORIGINAL }).c, ORDER, d),
    ).toEqual({
      sent: true,
    });
    expect(sentBody(d).subject).toContain('12345678');
  });

  it('never calls the auth API for a deleted account', async () => {
    const { c, getUserById } = client({ ...order, user_id: null });
    expect(await notifyOrderCancelled(c, ORDER, deps())).toEqual({
      sent: false,
      reason: 'lookup_failed',
    });
    expect(getUserById).not.toHaveBeenCalled();
    expect(await notifyRescanNeeded(c, null, deps())).toEqual({
      sent: false,
      reason: 'lookup_failed',
    });
  });

  it('lookup_failed for a missing order or address, or a throwing client', async () => {
    expect(await notifyOrderCancelled(client(null).c, ORDER, deps())).toEqual({
      sent: false,
      reason: 'lookup_failed',
    });
    expect(await notifyOrderCancelled(client(order, null).c, ORDER, deps())).toEqual({
      sent: false,
      reason: 'lookup_failed',
    });
    const throwing = {
      from: () => {
        throw new Error('boom');
      },
    } as never;
    expect(
      await notifyRefundIssued(
        throwing,
        ORDER,
        { amountCents: 1, currency: 'usd', full: true, cancelled: false },
        deps(),
      ),
    ).toEqual({ sent: false, reason: 'lookup_failed' });
  });

  it('not_configured and provider_error pass through without throwing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await notifyOrderCancelled(client(order).c, ORDER, deps({ apiKey: undefined }))).toEqual(
      {
        sent: false,
        reason: 'not_configured',
      },
    );
    const failing = deps({ fetch: vi.fn().mockResolvedValue({ ok: false, status: 500 }) as never });
    expect(await notifyRescanNeeded(client(order).c, 'u1', failing, ORDER)).toEqual({
      sent: false,
      reason: 'provider_error',
    });
  });

  it('audit detail carries the outcome, never the address', () => {
    expect(emailAuditDetail('refund_issued', { sent: true })).toEqual({
      template: 'refund_issued',
      sent: true,
      reason: null,
    });
    expect(emailAuditDetail('order_cancelled', { sent: false, reason: 'not_configured' })).toEqual({
      template: 'order_cancelled',
      sent: false,
      reason: 'not_configured',
    });
  });
});
