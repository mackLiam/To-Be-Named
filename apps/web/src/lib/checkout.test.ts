import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_CHECKOUT_BODY_BYTES,
  PENDING_ORDER_CAP,
  SESSION_TTL_SECONDS,
  bearerToken,
  corsHeaders,
  handleCheckout,
  parseCheckoutBody,
  preflightHeaders,
  priceOrder,
  readCappedText,
  type CheckoutDeps,
  type CheckoutProduct,
  type CheckoutScan,
  type CheckoutStore,
  type CheckoutStripe,
  type NewOrder,
} from './checkout';
import { getCheckoutAllowedOrigins, getSiteUrl, getStripeShippingCountries } from './env';

const USER = '00000000-0000-4000-8000-0000000000d1';
const OTHER = '00000000-0000-4000-8000-0000000000d2';
const PRODUCT = '00000000-0000-4000-8000-0000000000c1';
const LEFT = '00000000-0000-4000-8000-0000000000b1';
const RIGHT = '00000000-0000-4000-8000-0000000000b2';
const ORDER = '00000000-0000-4000-8000-0000000000a1';
const NOW = new Date('2026-09-30T12:00:00Z');

function scan(id: string, leg: string, patch: Partial<CheckoutScan> = {}): CheckoutScan {
  return { id, user_id: USER, leg, status: 'ready', deleted_at: null, ...patch };
}

function setup(
  opts: {
    product?: Partial<CheckoutProduct> | null;
    scans?: CheckoutScan[];
    validated?: string[];
    pending?: number;
    stripeFails?: boolean;
    sessionWriteFails?: boolean;
    user?: { id: string; email: string | null; is_anonymous: boolean } | null;
  } = {},
) {
  const log = {
    inserted: [] as NewOrder[],
    sessionWrites: [] as [string, string][],
    deleted: [] as string[],
    pendingQuery: [] as [string, string][],
    stripeCalls: [] as { params: unknown; options: { idempotencyKey: string } }[],
  };
  const store: CheckoutStore = {
    async getProduct(id) {
      if (opts.product === null || id !== PRODUCT) {
        return null;
      }
      return {
        id: PRODUCT,
        name: 'Custom Shin Guard',
        base_price_cents: 8900,
        currency: 'usd',
        active: true,
        ...opts.product,
      };
    },
    async getScans(ids) {
      return (opts.scans ?? [scan(LEFT, 'L'), scan(RIGHT, 'R')]).filter((s) => ids.includes(s.id));
    },
    async validatedScanIds(ids) {
      return (opts.validated ?? [LEFT, RIGHT]).filter((id) => ids.includes(id));
    },
    async countPendingSince(userId, since) {
      log.pendingQuery.push([userId, since]);
      return opts.pending ?? 0;
    },
    async insertOrder(order) {
      log.inserted.push(order);
      return ORDER;
    },
    async setCheckoutSession(orderId, sessionId) {
      if (opts.sessionWriteFails) {
        throw new Error('db down');
      }
      log.sessionWrites.push([orderId, sessionId]);
    },
    async deleteOrder(orderId) {
      log.deleted.push(orderId);
    },
  };
  const stripe: CheckoutStripe = {
    checkout: {
      sessions: {
        async create(params, options) {
          log.stripeCalls.push({ params, options });
          if (opts.stripeFails) {
            throw new Error('card network on fire');
          }
          return { id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' };
        },
      },
    },
  };
  const user =
    opts.user === undefined
      ? { id: USER, email: 'kid@example.com', is_anonymous: false }
      : opts.user;

  const deps = (patch: Partial<CheckoutDeps> = {}): CheckoutDeps => ({
    authorization: 'Bearer good-token',
    rawBody: JSON.stringify({ product_id: PRODUCT, scan_id_left: LEFT, scan_id_right: RIGHT }),
    config: { configured: true, siteUrl: 'https://zells.com', shippingCountries: ['US', 'CA'] },
    verifyToken: async (token) => (token === 'good-token' ? user : null),
    getStore: () => store,
    getStripe: () => stripe,
    now: () => NOW,
    ...patch,
  });
  return { deps, log };
}

describe('priceOrder', () => {
  it('charges the base price per leg', () => {
    expect(priceOrder({ base_price_cents: 8900 }, 1)).toEqual({
      unit_amount_cents: 8900,
      quantity: 1,
      amount_cents: 8900,
    });
    expect(priceOrder({ base_price_cents: 8900 }, 2).amount_cents).toBe(17800);
  });
});

describe('parseCheckoutBody', () => {
  const ok = { product_id: PRODUCT, scan_id_left: LEFT, scan_id_right: null };

  it('accepts one or two distinct scans', () => {
    expect(parseCheckoutBody(JSON.stringify(ok))).toEqual(ok);
    expect(
      parseCheckoutBody(JSON.stringify({ product_id: PRODUCT, scan_id_right: RIGHT })),
    ).toEqual({ product_id: PRODUCT, scan_id_left: null, scan_id_right: RIGHT });
  });

  it.each([
    ['not json', '{'],
    ['an array', '[]'],
    ['no scans', JSON.stringify({ ...ok, scan_id_left: null })],
    ['the same scan twice', JSON.stringify({ ...ok, scan_id_right: LEFT })],
    ['a bad product id', JSON.stringify({ ...ok, product_id: 'x' })],
    ['a non-string scan id', JSON.stringify({ ...ok, scan_id_left: 7 })],
    ['a missing product', JSON.stringify({ scan_id_left: LEFT })],
  ])('rejects %s', (_label, raw) => {
    expect(parseCheckoutBody(raw)).toBeNull();
  });
});

describe('bearerToken', () => {
  it('extracts the token and rejects anything else', () => {
    expect(bearerToken('Bearer abc.def')).toBe('abc.def');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken(`Bearer ${'x'.repeat(9000)}`)).toBeNull();
  });
});

describe('CORS', () => {
  const allowed = ['https://app.zells.com'];

  it('echoes an allowed origin and never uses *', () => {
    expect(corsHeaders('https://app.zells.com', allowed)).toEqual({
      Vary: 'Origin',
      'Access-Control-Allow-Origin': 'https://app.zells.com',
    });
    expect(preflightHeaders('https://app.zells.com', allowed)).toMatchObject({
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type',
    });
  });

  it('sends no allow headers for a disallowed or missing origin', () => {
    for (const origin of ['https://evil.example', 'https://app.zells.com.evil.example', null]) {
      expect(corsHeaders(origin, allowed)).toEqual({ Vary: 'Origin' });
      expect(preflightHeaders(origin, allowed)).toEqual({ Vary: 'Origin' });
    }
  });
});

describe('readCappedText', () => {
  const stream = (text: string) => new Response(text).body;

  it('reads a body within the cap', async () => {
    expect(await readCappedText(stream('{"a":1}'), MAX_CHECKOUT_BODY_BYTES)).toBe('{"a":1}');
    expect(await readCappedText(null, 10)).toBe('');
  });

  it('returns null for a body over the cap', async () => {
    expect(await readCappedText(stream('x'.repeat(MAX_CHECKOUT_BODY_BYTES + 1)), 4096)).toBeNull();
  });
});

describe('checkout env readers', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('parses comma lists and defaults shipping to US', () => {
    process.env.CHECKOUT_ALLOWED_ORIGINS = ' https://app.zells.com, http://localhost:8081 ,';
    process.env.SITE_URL = 'https://zells.com/';
    delete process.env.STRIPE_SHIPPING_COUNTRIES;
    expect(getCheckoutAllowedOrigins()).toEqual(['https://app.zells.com', 'http://localhost:8081']);
    expect(getSiteUrl()).toBe('https://zells.com');
    expect(getStripeShippingCountries()).toEqual(['US']);
    process.env.STRIPE_SHIPPING_COUNTRIES = 'us, ca';
    expect(getStripeShippingCountries()).toEqual(['US', 'CA']);
  });
});

describe('handleCheckout', () => {
  it('creates the order and a Stripe session for a valid pair', async () => {
    const { deps, log } = setup();
    const result = await handleCheckout(deps());

    expect(result).toEqual({
      status: 200,
      body: { url: 'https://checkout.stripe.com/c/pay/cs_test_1', order_id: ORDER },
    });
    expect(log.inserted).toEqual([
      {
        user_id: USER,
        product_id: PRODUCT,
        scan_id_left: LEFT,
        scan_id_right: RIGHT,
        status: 'pending_payment',
        amount_cents: 17800,
      },
    ]);
    expect(log.pendingQuery).toEqual([[USER, '2026-09-29T12:00:00.000Z']]);
    expect(log.stripeCalls).toHaveLength(1);
    expect(log.stripeCalls[0]!.options).toEqual({ idempotencyKey: `checkout-${ORDER}` });
    expect(log.stripeCalls[0]!.params).toEqual({
      mode: 'payment',
      allowed_payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: 8900,
            product_data: { name: 'Custom Shin Guard' },
          },
          quantity: 2,
        },
      ],
      client_reference_id: ORDER,
      metadata: { order_id: ORDER },
      customer_email: 'kid@example.com',
      shipping_address_collection: { allowed_countries: ['US', 'CA'] },
      success_url: `https://zells.com/checkout/success?order=${ORDER}`,
      cancel_url: `https://zells.com/checkout/cancelled?order=${ORDER}`,
      expires_at: Math.floor(NOW.getTime() / 1000) + SESSION_TTL_SECONDS,
    });
    expect(log.sessionWrites).toEqual([[ORDER, 'cs_test_1']]);
    expect(log.deleted).toEqual([]);
  });

  it('prices a single leg as one guard', async () => {
    const { deps, log } = setup();
    await handleCheckout(
      deps({ rawBody: JSON.stringify({ product_id: PRODUCT, scan_id_left: LEFT }) }),
    );
    expect(log.inserted[0]!.amount_cents).toBe(8900);
    expect(log.inserted[0]!.scan_id_right).toBeNull();
  });

  it('omits customer_email when the user has none', async () => {
    const { deps, log } = setup({ user: { id: USER, email: null, is_anonymous: false } });
    await handleCheckout(deps());
    expect(log.stripeCalls[0]!.params).not.toHaveProperty('customer_email');
  });

  it('501s when payments are not configured, before touching anything', async () => {
    const { deps, log } = setup();
    const result = await handleCheckout(
      deps({ config: { configured: false, siteUrl: '', shippingCountries: ['US'] } }),
    );
    expect(result).toEqual({ status: 501, body: { error: 'payments_not_configured' } });
    expect(log.inserted).toEqual([]);
  });

  it.each([
    ['no header', null],
    ['a non-bearer header', 'Basic abc'],
    ['a token the Auth server rejects', 'Bearer bad-token'],
  ])('401s on %s', async (_label, authorization) => {
    const { deps } = setup();
    expect(await handleCheckout(deps({ authorization }))).toEqual({
      status: 401,
      body: { error: 'unauthorized' },
    });
  });

  it('403s a guest (anonymous) user', async () => {
    const { deps, log } = setup({ user: { id: USER, email: null, is_anonymous: true } });
    expect(await handleCheckout(deps())).toEqual({
      status: 403,
      body: { error: 'account_required' },
    });
    expect(log.inserted).toEqual([]);
  });

  it('400s a bad body and an oversize body', async () => {
    const { deps, log } = setup();
    expect((await handleCheckout(deps({ rawBody: '{"product_id":1}' }))).body).toEqual({
      error: 'invalid_request',
    });
    expect(await handleCheckout(deps({ rawBody: null }))).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    expect(log.inserted).toEqual([]);
  });

  it('409s a missing or inactive product', async () => {
    for (const product of [null, { active: false }]) {
      const { deps, log } = setup({ product });
      expect(await handleCheckout(deps())).toEqual({
        status: 409,
        body: { error: 'product_unavailable' },
      });
      expect(log.inserted).toEqual([]);
    }
  });

  it.each([
    ['a wrong leg', { scans: [scan(LEFT, 'R'), scan(RIGHT, 'R')] }],
    ['another user scan', { scans: [scan(LEFT, 'L', { user_id: OTHER }), scan(RIGHT, 'R')] }],
    [
      'a deleted scan',
      { scans: [scan(LEFT, 'L'), scan(RIGHT, 'R', { deleted_at: '2026-09-01T00:00:00Z' })] },
    ],
    [
      'a scan that is not ready',
      { scans: [scan(LEFT, 'L', { status: 'processing' }), scan(RIGHT, 'R')] },
    ],
    ['a scan with no validated measurements', { validated: [LEFT] }],
    ['a scan that does not exist', { scans: [scan(LEFT, 'L')] }],
  ])('409s %s', async (_label, opts) => {
    const { deps, log } = setup(opts);
    expect(await handleCheckout(deps())).toEqual({
      status: 409,
      body: { error: 'scan_not_orderable' },
    });
    expect(log.inserted).toEqual([]);
    expect(log.stripeCalls).toEqual([]);
  });

  it('429s at the pending-order cap and allows one below it', async () => {
    const capped = setup({ pending: PENDING_ORDER_CAP });
    expect(await handleCheckout(capped.deps())).toEqual({
      status: 429,
      body: { error: 'too_many_pending' },
    });
    expect(capped.log.inserted).toEqual([]);

    const under = setup({ pending: PENDING_ORDER_CAP - 1 });
    expect((await handleCheckout(under.deps())).status).toBe(200);
  });

  it('502s a Stripe failure, removes the order and writes no session id', async () => {
    const { deps, log } = setup({ stripeFails: true });
    expect(await handleCheckout(deps())).toEqual({ status: 502, body: { error: 'stripe_error' } });
    expect(log.inserted).toHaveLength(1);
    expect(log.sessionWrites).toEqual([]);
    expect(log.deleted).toEqual([ORDER]);
  });

  it('withholds the URL when the session id cannot be stored', async () => {
    const { deps, log } = setup({ sessionWriteFails: true });
    const result = await handleCheckout(deps());
    expect(result).toEqual({ status: 500, body: { error: 'internal_error' } });
    expect(JSON.stringify(result)).not.toContain('checkout.stripe.com');
    expect(log.deleted).toEqual([ORDER]);
  });
});
