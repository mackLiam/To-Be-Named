import { describe, expect, it, vi } from 'vitest';

import {
  CHECKOUT_ERROR_MESSAGES,
  CHECKOUT_SERVER_ERRORS,
  CheckoutError,
  checkoutErrorMessage,
  checkoutRequestBody,
  formatMoney,
  orderTotalCents,
  startCheckout,
  type CheckoutDeps,
  type CheckoutErrorCode,
} from './checkout';
import type { Scan } from './library';

function scan(id: string, leg: Scan['leg']): Scan {
  return {
    id,
    leg,
    status: 'ready',
    pairId: 'p',
    createdAt: '2026-09-01T00:00:00Z',
    failedStep: null,
  };
}

const LEFT = scan('scan-l', 'L');
const RIGHT = scan('scan-r', 'R');
const INPUT = { productId: 'prod-1', legs: [RIGHT, LEFT] };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deps(overrides: Partial<CheckoutDeps> = {}): CheckoutDeps {
  return {
    apiUrl: 'https://zells.com',
    configured: true,
    getAccessToken: async () => 'token-123',
    fetch: vi.fn(async () =>
      jsonResponse(200, { url: 'https://checkout.stripe.com/c/pay/cs_1', order_id: 'order-1' }),
    ),
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<CheckoutErrorCode> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CheckoutError);
    return (err as CheckoutError).code;
  }
  throw new Error('expected startCheckout to throw');
}

describe('startCheckout', () => {
  it('posts the pinned body with the bearer token and returns url and order id', async () => {
    const d = deps({ apiUrl: 'https://zells.com/' });
    await expect(startCheckout(INPUT, d)).resolves.toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_1',
      orderId: 'order-1',
    });
    expect(d.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(d.fetch).mock.calls[0] ?? [];
    expect(url).toBe('https://zells.com/api/checkout');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      Authorization: 'Bearer token-123',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      product_id: 'prod-1',
      scan_id_left: 'scan-l',
      scan_id_right: 'scan-r',
    });
  });

  it.each([
    ['no API URL', { apiUrl: undefined }],
    ['an empty API URL', { apiUrl: '' }],
    ['fake-data mode', { configured: false }],
  ])('throws not_configured with %s and makes no request', async (_label, overrides) => {
    const d = deps(overrides);
    expect(await codeOf(startCheckout(INPUT, d))).toBe('not_configured');
    expect(d.fetch).not.toHaveBeenCalled();
  });

  it('throws unauthorized without a request when there is no access token', async () => {
    for (const getAccessToken of [async () => null, async () => Promise.reject(new Error('x'))]) {
      const d = deps({ getAccessToken });
      expect(await codeOf(startCheckout(INPUT, d))).toBe('unauthorized');
      expect(d.fetch).not.toHaveBeenCalled();
    }
  });

  it('maps a network failure to network', async () => {
    const d = deps({ fetch: vi.fn(async () => Promise.reject(new TypeError('offline'))) });
    expect(await codeOf(startCheckout(INPUT, d))).toBe('network');
  });

  const HTTP_STATUS: Record<(typeof CHECKOUT_SERVER_ERRORS)[number], number> = {
    invalid_request: 400,
    unauthorized: 401,
    account_required: 403,
    product_unavailable: 409,
    scan_not_orderable: 409,
    too_many_pending: 429,
    payments_not_configured: 501,
    stripe_error: 502,
  };

  it.each(CHECKOUT_SERVER_ERRORS)('passes through the server code %s', async (code) => {
    const d = deps({ fetch: vi.fn(async () => jsonResponse(HTTP_STATUS[code], { error: code })) });
    expect(await codeOf(startCheckout(INPUT, d))).toBe(code);
  });

  it('maps an unknown error code to network', async () => {
    const d = deps({ fetch: vi.fn(async () => jsonResponse(500, { error: 'boom' })) });
    expect(await codeOf(startCheckout(INPUT, d))).toBe('network');
  });

  it('maps a non-JSON error response to network', async () => {
    const d = deps({
      fetch: vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })),
    });
    expect(await codeOf(startCheckout(INPUT, d))).toBe('network');
  });

  it('maps a 200 that is not JSON, or lacks url/order_id, or has a non-https url, to network', async () => {
    for (const response of [
      () => new Response('ok', { status: 200 }),
      () => jsonResponse(200, { url: 'https://checkout.stripe.com/x' }),
      () => jsonResponse(200, { order_id: 'o' }),
      () => jsonResponse(200, { url: 'javascript:alert(1)', order_id: 'o' }),
      () => jsonResponse(200, { url: 'http://checkout.stripe.com/x', order_id: 'o' }),
    ]) {
      const d = deps({ fetch: vi.fn(async () => response()) });
      expect(await codeOf(startCheckout(INPUT, d))).toBe('network');
    }
  });
});

describe('checkoutRequestBody', () => {
  it('fills only the slot matching each leg', () => {
    expect(checkoutRequestBody({ productId: 'p', legs: [LEFT] })).toEqual({
      product_id: 'p',
      scan_id_left: 'scan-l',
      scan_id_right: null,
    });
    expect(checkoutRequestBody({ productId: 'p', legs: [RIGHT] })).toEqual({
      product_id: 'p',
      scan_id_left: null,
      scan_id_right: 'scan-r',
    });
  });
});

describe('checkoutErrorMessage', () => {
  const codes: CheckoutErrorCode[] = [...CHECKOUT_SERVER_ERRORS, 'network', 'not_configured'];

  it('has one plain sentence for every code, and no raw code leaks into the copy', () => {
    expect(Object.keys(CHECKOUT_ERROR_MESSAGES).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const message = checkoutErrorMessage(code);
      expect(message).toMatch(/^[A-Z].*\.$/);
      expect(message).not.toContain('_');
      expect(message).not.toMatch(/[–—]/);
    }
  });

  it('says payments are not connected in a build without them', () => {
    expect(checkoutErrorMessage('not_configured')).toBe(
      'Payments are not connected in this build.',
    );
  });
});

describe('orderTotalCents', () => {
  it('is the price per guard times the number of legs', () => {
    expect(orderTotalCents(8900, 1)).toBe(8900);
    expect(orderTotalCents(8900, 2)).toBe(17800);
  });
});

describe('formatMoney', () => {
  it('formats cents in the given currency, whatever its case', () => {
    expect(formatMoney(17800, 'usd')).toBe('$178.00');
    expect(formatMoney(8900, 'USD')).toBe('$89.00');
  });
});
