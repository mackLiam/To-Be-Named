import { describe, expect, it, vi } from 'vitest';

import {
  handleStripeWebhook,
  mapShippingAddress,
  type RpcResult,
  type WebhookDeps,
  type WebhookEvent,
} from './stripe-webhook';

const ADDRESS = {
  line1: '1 Pitch Rd',
  line2: null,
  city: 'Springfield',
  state: 'OR',
  postal_code: '97477',
  country: 'US',
};

const FLAT = {
  name: 'Sam Keeper',
  line1: '1 Pitch Rd',
  line2: null,
  city: 'Springfield',
  state: 'OR',
  postal_code: '97477',
  country: 'US',
};

function paidSession(patch: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_1',
    payment_status: 'paid',
    payment_intent: 'pi_123',
    amount_total: 17800,
    currency: 'usd',
    collected_information: { shipping_details: { name: 'Sam Keeper', address: ADDRESS } },
    ...patch,
  };
}

function setup(
  event: WebhookEvent | Error,
  rpcResult: RpcResult = { data: 'applied', error: null },
) {
  const rpc = vi.fn(async () => rpcResult);
  const constructEvent = vi.fn(() => {
    if (event instanceof Error) {
      throw event;
    }
    return event;
  });
  const deps = (patch: Partial<WebhookDeps> = {}): WebhookDeps => ({
    configured: true,
    rawBody: '{"id":"evt_1"}',
    signature: 't=1,v1=abc',
    constructEvent,
    rpc,
    ...patch,
  });
  return { deps, rpc, constructEvent };
}

const evt = (type: string, object: unknown): WebhookEvent => ({
  id: 'evt_1',
  type,
  data: { object },
});

describe('mapShippingAddress', () => {
  it('reads collected_information.shipping_details (current API versions)', () => {
    expect(mapShippingAddress(paidSession())).toEqual(FLAT);
  });

  it('reads top-level shipping_details (older API versions)', () => {
    expect(
      mapShippingAddress({ shipping_details: { name: 'Sam Keeper', address: ADDRESS } }),
    ).toEqual(FLAT);
  });

  it('returns null with no shipping and nulls non-string fields', () => {
    expect(mapShippingAddress({})).toBeNull();
    expect(
      mapShippingAddress({ shipping_details: { name: 5, address: { line1: '', city: 'X' } } }),
    ).toEqual({
      name: null,
      line1: null,
      line2: null,
      city: 'X',
      state: null,
      postal_code: null,
      country: null,
    });
  });
});

describe('handleStripeWebhook', () => {
  it('501s when unconfigured without verifying anything', async () => {
    const { deps, constructEvent, rpc } = setup(evt('charge.refunded', {}));
    expect(await handleStripeWebhook(deps({ configured: false }))).toEqual({
      status: 501,
      body: { error: 'payments_not_configured' },
    });
    expect(constructEvent).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('400s a bad signature and writes nothing', async () => {
    const { deps, rpc } = setup(new Error('No signatures found matching the expected signature'));
    const result = await handleStripeWebhook(deps());
    expect(result).toEqual({ status: 400, body: { error: 'invalid_signature' } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('400s a missing signature header or an oversize body', async () => {
    const { deps, constructEvent } = setup(evt('charge.refunded', {}));
    expect((await handleStripeWebhook(deps({ signature: null }))).status).toBe(400);
    expect((await handleStripeWebhook(deps({ rawBody: null }))).status).toBe(400);
    expect(constructEvent).not.toHaveBeenCalled();
  });

  it.each(['checkout.session.completed', 'checkout.session.async_payment_succeeded'])(
    'maps a paid %s to stripe_checkout_completed',
    async (type) => {
      const { deps, rpc } = setup(evt(type, paidSession()));
      expect(await handleStripeWebhook(deps())).toEqual({
        status: 200,
        body: { received: true },
      });
      expect(rpc).toHaveBeenCalledWith('stripe_checkout_completed', {
        p_event_id: 'evt_1',
        p_session_id: 'cs_test_1',
        p_payment_intent: 'pi_123',
        p_amount_cents: 17800,
        p_currency: 'usd',
        p_address: FLAT,
      });
    },
  );

  it('sends the confirmation only when the payment was newly applied', async () => {
    for (const [result, sends] of [
      ['applied', 1],
      ['duplicate', 0],
      ['ignored', 0],
    ] as const) {
      const onOrderPaid = vi.fn(async () => undefined);
      const { deps } = setup(evt('checkout.session.completed', paidSession()), {
        data: result,
        error: null,
      });
      expect((await handleStripeWebhook(deps({ onOrderPaid }))).status).toBe(200);
      expect(onOrderPaid).toHaveBeenCalledTimes(sends);
      if (sends) {
        expect(onOrderPaid).toHaveBeenCalledWith('cs_test_1');
      }
    }
  });

  it('still answers 200 when the confirmation email fails', async () => {
    const onOrderPaid = vi.fn(async () => {
      throw new Error('smtp down');
    });
    const { deps } = setup(evt('checkout.session.completed', paidSession()));
    expect((await handleStripeWebhook(deps({ onOrderPaid }))).status).toBe(200);
  });

  it('reads an expanded payment_intent object and the legacy shipping field', async () => {
    const session = paidSession({
      payment_intent: { id: 'pi_456' },
      collected_information: null,
      shipping_details: { name: 'Sam Keeper', address: ADDRESS },
    });
    const { deps, rpc } = setup(evt('checkout.session.completed', session));
    await handleStripeWebhook(deps());
    expect(rpc).toHaveBeenCalledWith(
      'stripe_checkout_completed',
      expect.objectContaining({ p_payment_intent: 'pi_456', p_address: FLAT }),
    );
  });

  it('acknowledges an unpaid completed session without calling any RPC', async () => {
    const { deps, rpc } = setup(
      evt('checkout.session.completed', paidSession({ payment_status: 'unpaid' })),
    );
    expect(await handleStripeWebhook(deps())).toEqual({ status: 200, body: { received: true } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps checkout.session.expired', async () => {
    const { deps, rpc } = setup(evt('checkout.session.expired', { id: 'cs_test_1' }));
    expect((await handleStripeWebhook(deps())).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith('stripe_checkout_expired', {
      p_event_id: 'evt_1',
      p_session_id: 'cs_test_1',
    });
  });

  it('maps charge.refunded, full and partial', async () => {
    for (const refunded of [true, false]) {
      const { deps, rpc } = setup(evt('charge.refunded', { payment_intent: 'pi_123', refunded }));
      expect((await handleStripeWebhook(deps())).status).toBe(200);
      expect(rpc).toHaveBeenCalledWith('stripe_charge_refunded', {
        p_event_id: 'evt_1',
        p_payment_intent: 'pi_123',
        p_fully_refunded: refunded,
      });
    }
  });

  it('answers 200 to a duplicate (replayed) event', async () => {
    const { deps } = setup(evt('checkout.session.expired', { id: 'cs_test_1' }), {
      data: 'duplicate',
      error: null,
    });
    expect(await handleStripeWebhook(deps())).toEqual({ status: 200, body: { received: true } });
  });

  it('ignores unknown event types', async () => {
    const { deps, rpc } = setup(evt('customer.created', {}));
    expect(await handleStripeWebhook(deps())).toEqual({ status: 200, body: { received: true } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('500s on an RPC error so Stripe retries, with no detail in the body', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps } = setup(evt('checkout.session.completed', paidSession()), {
      data: null,
      error: { message: 'relation "orders" secret detail' },
    });
    const result = await handleStripeWebhook(deps());
    expect(result).toEqual({ status: 500, body: { error: 'processing_failed' } });
    expect(JSON.stringify(result)).not.toContain('secret detail');
    spy.mockRestore();
  });
});
