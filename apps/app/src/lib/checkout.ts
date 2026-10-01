/**
 * Client half of POST /api/checkout (apps/web, Stripe hosted Checkout). The
 * app never prices, charges or talks to Stripe: it asks the site for a
 * Checkout URL and opens it. Pure apart from the injected fetch, so every
 * response path is unit-tested (checkout.test.ts).
 */

import type { Scan } from './library';

/** Error codes the endpoint returns as `{ "error": code }`. */
export const CHECKOUT_SERVER_ERRORS = [
  'invalid_request',
  'unauthorized',
  'account_required',
  'account_deleting',
  'product_unavailable',
  'scan_not_orderable',
  'too_many_pending',
  'payments_not_configured',
  'stripe_error',
  'internal_error',
] as const;

export type CheckoutErrorCode =
  | (typeof CHECKOUT_SERVER_ERRORS)[number]
  /** Unreachable server, unknown code, or a response we cannot read. */
  | 'network'
  /** This build has no API URL or no backend: no request is ever made. */
  | 'not_configured';

export class CheckoutError extends Error {
  constructor(readonly code: CheckoutErrorCode) {
    super(code);
    this.name = 'CheckoutError';
  }
}

export interface CheckoutInput {
  productId: string;
  /** The legs to make, from orderableLegs. */
  legs: readonly Scan[];
}

export interface CheckoutDeps {
  apiUrl: string | undefined;
  /** False in fake-data mode (no Supabase config). */
  configured: boolean;
  getAccessToken: () => Promise<string | null>;
  fetch: typeof fetch;
}

export interface CheckoutSession {
  /** Stripe-hosted page. Open it at once; never store it. */
  url: string;
  orderId: string;
}

/** The pinned request body: the left slot only takes a leg 'L' scan, the right only 'R'. */
export function checkoutRequestBody(input: CheckoutInput) {
  return {
    product_id: input.productId,
    scan_id_left: input.legs.find((scan) => scan.leg === 'L')?.id ?? null,
    scan_id_right: input.legs.find((scan) => scan.leg === 'R')?.id ?? null,
  };
}

export async function startCheckout(
  input: CheckoutInput,
  deps: CheckoutDeps,
): Promise<CheckoutSession> {
  if (!deps.configured || !deps.apiUrl) {
    throw new CheckoutError('not_configured');
  }
  const token = await deps.getAccessToken().catch(() => null);
  if (!token) {
    throw new CheckoutError('unauthorized');
  }

  let response: Response;
  try {
    response = await deps.fetch(`${deps.apiUrl.replace(/\/+$/, '')}/api/checkout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(checkoutRequestBody(input)),
    });
  } catch {
    throw new CheckoutError('network');
  }

  const body: unknown = await response.json().catch(() => null);
  const record = (body ?? {}) as Record<string, unknown>;

  if (response.ok) {
    const { url, order_id: orderId } = record;
    // Only ever open an https page handed back by our own server.
    if (typeof url === 'string' && url.startsWith('https://') && typeof orderId === 'string') {
      return { url, orderId };
    }
    throw new CheckoutError('network');
  }
  const code = CHECKOUT_SERVER_ERRORS.find((known) => known === record.error);
  throw new CheckoutError(code ?? 'network');
}

/** One sentence per code telling the user what to do. Raw error text never reaches the UI. */
export const CHECKOUT_ERROR_MESSAGES: Record<CheckoutErrorCode, string> = {
  invalid_request: 'Something in this order did not add up. Go back to your scan and start again.',
  unauthorized: 'Your session has expired. Sign in again, then retry.',
  account_required: 'Orders need a saved account. Save your scans to an account in Profile first.',
  account_deleting: 'Your account is being deleted, so it cannot place orders.',
  product_unavailable: 'That guard is no longer on sale. Pick another one.',
  scan_not_orderable:
    'This scan can no longer be ordered from. Pull down on the scan to refresh it, or rescan.',
  too_many_pending:
    'You have several unpaid orders open. Finish or let one expire before starting another.',
  payments_not_configured: 'Payments are not switched on yet. Try again later.',
  stripe_error: 'The payment page could not be opened. Try again in a minute.',
  internal_error: 'Something went wrong on our side. Try again in a minute.',
  network: 'Could not reach the payment service. Check your connection and try again.',
  not_configured: 'Payments are not connected in this build.',
};

export function checkoutErrorMessage(code: CheckoutErrorCode): string {
  return CHECKOUT_ERROR_MESSAGES[code];
}

/** Display only, mirroring the server rule (price per guard times legs). The
 * amount Stripe charges is computed server-side and is the authority. */
export function orderTotalCents(priceCents: number, legCount: number): number {
  return priceCents * legCount;
}

/** "$89.00". Currency is ISO 4217 in any case (Stripe stores lower case). */
export function formatMoney(cents: number, currency: string): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  });
}
