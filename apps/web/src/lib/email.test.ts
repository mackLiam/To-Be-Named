import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  notifyOrderConfirmed,
  notifyOrderShipped,
  orderConfirmedEmail,
  orderShippedEmail,
  sendEmail,
  type EmailDeps,
} from './email';

const msg = { to: 'c@example.test', subject: 's', text: 't' };

function deps(over: Partial<EmailDeps> = {}): EmailDeps {
  return {
    fetch: vi.fn().mockResolvedValue({ ok: true, status: 200 }) as never,
    apiKey: 'rk_secret',
    from: 'FORMS <orders@example.test>',
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstCall(d: EmailDeps): any[] {
  return (d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
}

describe('sendEmail', () => {
  it.each([{ apiKey: undefined }, { from: undefined }])(
    'skips when not configured (%o), logging no address',
    async (over) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const d = deps(over);
      expect(await sendEmail(d, msg)).toEqual({ sent: false, reason: 'not_configured' });
      expect(d.fetch).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith('email skipped: not configured');
    },
  );

  it('posts the payload with the key only in the header', async () => {
    const d = deps();
    expect(await sendEmail(d, msg)).toEqual({ sent: true });
    const [url, init] = firstCall(d);
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer rk_secret');
    expect(JSON.parse(init.body)).toEqual({
      from: 'FORMS <orders@example.test>',
      to: 'c@example.test',
      subject: 's',
      text: 't',
    });
    expect(init.body).not.toContain('rk_secret');
  });

  it('returns provider_error on non-2xx without leaking the address', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const d = deps({ fetch: vi.fn().mockResolvedValue({ ok: false, status: 422 }) as never });
    expect(await sendEmail(d, msg)).toEqual({ sent: false, reason: 'provider_error' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('example.test');
  });

  it('returns provider_error when fetch rejects', async () => {
    const d = deps({ fetch: vi.fn().mockRejectedValue(new Error('down')) as never });
    expect(await sendEmail(d, msg)).toEqual({ sent: false, reason: 'provider_error' });
  });
});

describe('templates', () => {
  it('confirmed email uses the uppercased 8 char reference and money format', () => {
    const { subject, text } = orderConfirmedEmail({
      orderId: 'abcdef12-3456-7890-abcd-ef1234567890',
      productName: 'Pro Guard',
      amountCents: 12900,
      currency: 'usd',
    });
    expect(subject).toContain('ABCDEF12');
    expect(text).toContain('$129.00');
    expect(text).toContain('Pro Guard');
    expect(text).toContain('reach our support team');
  });

  it('shipped email includes carrier and number', () => {
    const { text } = orderShippedEmail({
      orderId: 'abcdef12-0000',
      productName: 'Pro Guard',
      trackingCarrier: 'UPS',
      trackingNumber: '1Z999',
    });
    expect(text).toContain('Tracking: UPS 1Z999.');
  });

  it('shipped email handles a null carrier and null number', () => {
    const noCarrier = orderShippedEmail({
      orderId: 'abcdef12-0000',
      productName: 'P',
      trackingCarrier: null,
      trackingNumber: '1Z999',
    });
    expect(noCarrier.text).toContain('Tracking: 1Z999.');
    expect(noCarrier.text).not.toContain('null');
    const none = orderShippedEmail({
      orderId: 'abcdef12-0000',
      productName: 'P',
      trackingCarrier: null,
      trackingNumber: null,
    });
    expect(none.text).not.toContain('null');
  });
});

describe('notifyOrderShipped', () => {
  function client(order: unknown, user: unknown, orderError: unknown = null) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: order, error: orderError }) }),
        }),
      }),
      auth: { admin: { getUserById: vi.fn().mockResolvedValue(user) } },
    } as never;
  }
  const order = {
    id: 'abcdef12-0000',
    user_id: 'u1',
    tracking_carrier: 'UPS',
    tracking_number: '1Z',
    products: { name: 'Pro Guard' },
  };

  it('sends to the customer email', async () => {
    const d = deps();
    const c = client(order, { data: { user: { email: 'c@example.test' } }, error: null });
    expect(await notifyOrderShipped(c, 'o1', d)).toEqual({ sent: true });
    const body = JSON.parse(firstCall(d)[1].body);
    expect(body.to).toBe('c@example.test');
    expect(body.text).toContain('Pro Guard');
  });

  it('lookup_failed when the order is missing', async () => {
    expect(await notifyOrderShipped(client(null, null), 'o1', deps())).toEqual({
      sent: false,
      reason: 'lookup_failed',
    });
  });

  it('lookup_failed when the user has no email', async () => {
    const c = client(order, { data: { user: { email: null } }, error: null });
    expect(await notifyOrderShipped(c, 'o1', deps())).toEqual({
      sent: false,
      reason: 'lookup_failed',
    });
  });

  it('lookup_failed when a query throws', async () => {
    const c = {
      from: () => {
        throw new Error('boom');
      },
    } as never;
    expect(await notifyOrderShipped(c, 'o1', deps())).toEqual({
      sent: false,
      reason: 'lookup_failed',
    });
  });
});

describe('notifyOrderConfirmed', () => {
  function client(order: unknown, user: unknown) {
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: order, error: null }) }));
    return {
      eq,
      c: {
        from: () => ({ select: () => ({ eq }) }),
        auth: { admin: { getUserById: vi.fn().mockResolvedValue(user) } },
      } as never,
    };
  }
  const order = {
    id: 'abcdef12-0000',
    user_id: 'u1',
    amount_cents: 17800,
    products: { name: 'Club Guard', currency: 'usd' },
  };

  it('finds the order by session id and emails the charged amount', async () => {
    const d = deps();
    const { c, eq } = client(order, { data: { user: { email: 'c@example.test' } }, error: null });
    expect(await notifyOrderConfirmed(c, 'cs_1', d)).toEqual({ sent: true });
    expect(eq).toHaveBeenCalledWith('stripe_checkout_session_id', 'cs_1');
    const body = JSON.parse(firstCall(d)[1].body);
    expect(body.to).toBe('c@example.test');
    expect(body.text).toContain('$178.00');
    expect(body.subject).toContain('ABCDEF12');
  });

  it('lookup_failed when the order has no amount or is missing', async () => {
    const user = { data: { user: { email: 'c@example.test' } }, error: null };
    for (const o of [null, { ...order, amount_cents: null }]) {
      expect(await notifyOrderConfirmed(client(o, user).c, 'cs_1', deps())).toEqual({
        sent: false,
        reason: 'lookup_failed',
      });
    }
  });
});
