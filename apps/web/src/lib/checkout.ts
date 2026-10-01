import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrderStatus, ScanStatus } from '@forms/shared';
import type Stripe from 'stripe';

import { isUuid } from './shop';

/**
 * POST /api/checkout logic: who may buy, what they may buy, what it costs,
 * and the Stripe Checkout Session that collects it. Framework-free and
 * dependency-injected (same shape as stl.ts) so every branch is unit tested
 * with fakes; app/api/checkout/route.ts only wires the real clients.
 *
 * Trust: the caller supplies ids only. Ownership, leg, scan readiness,
 * product state and the price are all re-derived here from the database via
 * the SERVICE ROLE store, never taken from the request.
 */

export const MAX_CHECKOUT_BODY_BYTES = 4096;
// Bounds abandoned checkouts per user (each one holds a Stripe session).
export const PENDING_ORDER_CAP = 5;
export const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;
// Stripe's floor for expires_at is 30 minutes after creation; the extra
// minute absorbs clock skew between this server and Stripe.
export const SESSION_TTL_SECONDS = 31 * 60;
const MAX_TOKEN_LENGTH = 8192;

export type CheckoutErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'account_required'
  | 'account_deleting'
  | 'product_unavailable'
  | 'scan_not_orderable'
  | 'too_many_pending'
  | 'payments_not_configured'
  | 'stripe_error'
  | 'internal_error';

export const CHECKOUT_ERROR_STATUS: Record<CheckoutErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  account_required: 403,
  account_deleting: 409,
  product_unavailable: 409,
  scan_not_orderable: 409,
  too_many_pending: 429,
  payments_not_configured: 501,
  stripe_error: 502,
  internal_error: 500,
};

export interface CheckoutResult {
  status: number;
  body: { url: string; order_id: string } | { error: CheckoutErrorCode };
}

function fail(code: CheckoutErrorCode): CheckoutResult {
  return { status: CHECKOUT_ERROR_STATUS[code], body: { error: code } };
}

// ---------------------------------------------------------------------------
// Pure pieces.
// ---------------------------------------------------------------------------

export interface CheckoutRequest {
  product_id: string;
  scan_id_left: string | null;
  scan_id_right: string | null;
}

function optionalUuid(value: unknown): string | null | undefined {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'string' && isUuid(value) ? value.toLowerCase() : undefined;
}

/** Null when the body is not a valid checkout request. */
export function parseCheckoutBody(raw: string): CheckoutRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const body = parsed as Record<string, unknown>;
  const productId = optionalUuid(body.product_id);
  const left = optionalUuid(body.scan_id_left);
  const right = optionalUuid(body.scan_id_right);
  if (!productId || left === undefined || right === undefined) {
    return null;
  }
  if ((left === null && right === null) || left === right) {
    return null;
  }
  return { product_id: productId, scan_id_left: left, scan_id_right: right };
}

export interface OrderPrice {
  unit_amount_cents: number;
  quantity: number;
  amount_cents: number;
}

/**
 * THE single place order pricing is decided. Each leg is a separate printed
 * guard, so a pair costs twice the base price. The Stripe line item and the
 * amount stored on the order (which the webhook RPC checks the paid total
 * against) both derive from this; change pricing here and nowhere else.
 */
export function priceOrder(product: { base_price_cents: number }, legs: number): OrderPrice {
  return {
    unit_amount_cents: product.base_price_cents,
    quantity: legs,
    amount_cents: product.base_price_cents * legs,
  };
}

/** "Bearer <token>" -> token, or null. */
export function bearerToken(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '');
  if (!match || match[1]!.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  return match[1]!;
}

/**
 * CORS for the Expo web build. Exact-origin allowlist, never '*'. Native app
 * requests carry no Origin and need no headers. Auth is a bearer token, not a
 * cookie, so a disallowed origin gains nothing; it just gets no ACAO header.
 */
export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function preflightHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const headers = corsHeaders(origin, allowed);
  if (headers['Access-Control-Allow-Origin']) {
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'authorization, content-type';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

/**
 * Read at most maxBytes from a request body stream. Null when the body is
 * larger, so an oversized upload is cut off instead of buffered whole.
 */
export async function readCappedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string | null> {
  if (!body) {
    return '';
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ---------------------------------------------------------------------------
// Seams.
// ---------------------------------------------------------------------------

export interface CheckoutUser {
  id: string;
  email: string | null;
  is_anonymous: boolean;
}

export interface CheckoutProduct {
  id: string;
  name: string;
  base_price_cents: number;
  currency: string;
  active: boolean;
}

export interface CheckoutScan {
  id: string;
  user_id: string;
  leg: string;
  status: string;
  deleted_at: string | null;
}

export interface NewOrder {
  user_id: string;
  product_id: string;
  scan_id_left: string | null;
  scan_id_right: string | null;
  status: OrderStatus;
  amount_cents: number;
}

/** The database access checkout needs; production impl below, fakes in tests. */
export interface CheckoutStore {
  /** The user asked to delete their account (0012 account_deletion_requests). */
  hasDeletionRequest(userId: string): Promise<boolean>;
  getProduct(id: string): Promise<CheckoutProduct | null>;
  getScans(ids: string[]): Promise<CheckoutScan[]>;
  /** Of `ids`, the scans that have at least one validated measurements row. */
  validatedScanIds(ids: string[]): Promise<string[]>;
  countPendingSince(userId: string, sinceIso: string): Promise<number>;
  insertOrder(order: NewOrder): Promise<string>;
  setCheckoutSession(orderId: string, sessionId: string): Promise<void>;
  deleteOrder(orderId: string): Promise<void>;
}

export interface CheckoutStripe {
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
        options: { idempotencyKey: string },
      ): Promise<{ id: string; url: string | null }>;
    };
  };
}

export interface CheckoutConfig {
  /** Stripe key, Supabase anon + service role, and SITE_URL all present. */
  configured: boolean;
  siteUrl: string;
  shippingCountries: string[];
}

export interface CheckoutDeps {
  authorization: string | null;
  /** The request body, or null when it exceeded MAX_CHECKOUT_BODY_BYTES. */
  rawBody: string | null;
  config: CheckoutConfig;
  verifyToken(token: string): Promise<CheckoutUser | null>;
  getStore(): CheckoutStore;
  getStripe(): CheckoutStripe;
  now?: () => Date;
}

const PENDING: OrderStatus = 'pending_payment';
const READY: ScanStatus = 'ready';

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

export async function handleCheckout(deps: CheckoutDeps): Promise<CheckoutResult> {
  if (!deps.config.configured) {
    return fail('payments_not_configured');
  }
  if (deps.rawBody === null) {
    return fail('invalid_request');
  }

  const token = bearerToken(deps.authorization);
  const user = token ? await deps.verifyToken(token) : null;
  if (!user) {
    return fail('unauthorized');
  }
  if (user.is_anonymous) {
    return fail('account_required');
  }

  const request = parseCheckoutBody(deps.rawBody);
  if (!request) {
    return fail('invalid_request');
  }

  const store = deps.getStore();
  // The service role skips the RLS check that refuses orders during account
  // deletion, so it is repeated here: the deletion worker would otherwise
  // delete the user while this session is still payable.
  if (await store.hasDeletionRequest(user.id)) {
    return fail('account_deleting');
  }
  const product = await store.getProduct(request.product_id);
  if (!product || !product.active) {
    return fail('product_unavailable');
  }

  const wanted: { id: string; leg: 'L' | 'R' }[] = [];
  if (request.scan_id_left) {
    wanted.push({ id: request.scan_id_left, leg: 'L' });
  }
  if (request.scan_id_right) {
    wanted.push({ id: request.scan_id_right, leg: 'R' });
  }
  const ids = wanted.map((w) => w.id);
  const [scans, validated] = await Promise.all([store.getScans(ids), store.validatedScanIds(ids)]);
  // One code for every reason (including "not yours") so the response never
  // confirms that someone else's scan id exists.
  const orderable = wanted.every(({ id, leg }) => {
    const scan = scans.find((s) => s.id === id);
    return (
      scan !== undefined &&
      scan.user_id === user.id &&
      scan.leg === leg &&
      scan.deleted_at === null &&
      scan.status === READY &&
      validated.includes(id)
    );
  });
  if (!orderable) {
    return fail('scan_not_orderable');
  }

  const now = (deps.now ?? (() => new Date()))();
  // ponytail: count-then-insert is not atomic, so parallel requests can pass
  // the cap by a few; a per-user advisory lock in an RPC if that is abused.
  const pending = await store.countPendingSince(
    user.id,
    new Date(now.getTime() - PENDING_WINDOW_MS).toISOString(),
  );
  if (pending >= PENDING_ORDER_CAP) {
    return fail('too_many_pending');
  }

  const price = priceOrder(product, wanted.length);
  const orderId = await store.insertOrder({
    user_id: user.id,
    product_id: product.id,
    scan_id_left: request.scan_id_left,
    scan_id_right: request.scan_id_right,
    status: PENDING,
    amount_cents: price.amount_cents,
  });

  let session: { id: string; url: string | null };
  try {
    session = await deps.getStripe().checkout.sessions.create(
      buildSessionParams({
        orderId,
        product,
        price,
        email: user.email,
        config: deps.config,
        now,
      }),
      { idempotencyKey: `checkout-${orderId}` },
    );
  } catch {
    // No session reached the customer, so the order is dropped rather than
    // left pending with no way to pay it (and counting against the cap).
    await store.deleteOrder(orderId).catch(() => undefined);
    return fail('stripe_error');
  }
  if (!session.url) {
    await store.deleteOrder(orderId).catch(() => undefined);
    return fail('stripe_error');
  }

  try {
    await store.setCheckoutSession(orderId, session.id);
  } catch {
    // Without the session id the webhook cannot find this order, so the URL
    // is withheld: nobody can pay a session the order does not know about.
    await store.deleteOrder(orderId).catch(() => undefined);
    return fail('internal_error');
  }

  return { status: 200, body: { url: session.url, order_id: orderId } };
}

export function buildSessionParams(input: {
  orderId: string;
  product: CheckoutProduct;
  price: OrderPrice;
  email: string | null;
  config: CheckoutConfig;
  now: Date;
}): Stripe.Checkout.SessionCreateParams {
  const { orderId, product, price, email, config, now } = input;
  return {
    mode: 'payment',
    // Cards only (wallets such as Apple Pay are cards): delayed methods would
    // complete the session unpaid and need an async failure path we lack.
    allowed_payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: product.currency,
          unit_amount: price.unit_amount_cents,
          product_data: { name: product.name },
        },
        quantity: price.quantity,
      },
    ],
    client_reference_id: orderId,
    metadata: { order_id: orderId },
    ...(email ? { customer_email: email } : {}),
    shipping_address_collection: {
      allowed_countries:
        config.shippingCountries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
    },
    success_url: `${config.siteUrl}/checkout/success?order=${orderId}`,
    cancel_url: `${config.siteUrl}/checkout/cancelled?order=${orderId}`,
    expires_at: Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Production store (SERVICE ROLE client). Thin by rule: every decision is in
// handleCheckout above; these only fetch and write, bounded by the id lists.
// ---------------------------------------------------------------------------

export function supabaseCheckoutStore(client: SupabaseClient): CheckoutStore {
  const check = <T>(result: { data: T; error: unknown }): T => {
    if (result.error) {
      throw result.error;
    }
    return result.data;
  };
  return {
    async hasDeletionRequest(userId) {
      const { count, error } = await client
        .from('account_deletion_requests')
        .select('user_id', { count: 'exact', head: true })
        .eq('user_id', userId);
      if (error) {
        throw error;
      }
      return (count ?? 0) > 0;
    },
    async getProduct(id) {
      return check(
        await client
          .from('products')
          .select('id, name, base_price_cents, currency, active')
          .eq('id', id)
          .maybeSingle(),
      ) as CheckoutProduct | null;
    },
    async getScans(ids) {
      return (check(
        await client
          .from('scans')
          .select('id, user_id, leg, status, deleted_at')
          .in('id', ids)
          .limit(ids.length),
      ) ?? []) as CheckoutScan[];
    },
    async validatedScanIds(ids) {
      // Measurements are versioned per scan; the bound covers several
      // extraction versions per leg.
      const rows = (check(
        await client
          .from('measurements')
          .select('scan_id')
          .in('scan_id', ids)
          .eq('validated', true)
          .limit(ids.length * 20),
      ) ?? []) as { scan_id: string }[];
      return rows.map((row) => row.scan_id);
    },
    async countPendingSince(userId, sinceIso) {
      const { count, error } = await client
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId)
        .eq('status', PENDING)
        .gte('created_at', sinceIso);
      if (error) {
        throw error;
      }
      return count ?? 0;
    },
    async insertOrder(order) {
      const row = check(await client.from('orders').insert(order).select('id').single()) as {
        id: string;
      };
      return row.id;
    },
    async setCheckoutSession(orderId, sessionId) {
      check(
        await client
          .from('orders')
          .update({ stripe_checkout_session_id: sessionId })
          .eq('id', orderId),
      );
    },
    async deleteOrder(orderId) {
      // Only an unpaid order that never got a session may be removed.
      check(
        await client
          .from('orders')
          .delete()
          .eq('id', orderId)
          .eq('status', PENDING)
          .is('stripe_checkout_session_id', null),
      );
    },
  };
}
