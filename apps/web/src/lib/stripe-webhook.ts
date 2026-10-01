/**
 * POST /api/stripe/webhook logic. Framework-free and dependency-injected so
 * every branch is unit tested; app/api/stripe/webhook/route.ts only wires the
 * real Stripe verifier and SERVICE ROLE client.
 *
 * Idempotency lives in the 0013 RPCs: each records the event id in the same
 * transaction as its effect, so a replay returns 'duplicate' and this handler
 * can answer 200 without any "already processed" bookkeeping of its own.
 * Any RPC error answers 500 so Stripe retries the event.
 */

// Signature-verified Stripe events are a few KB; this only stops an
// unauthenticated caller from making the server buffer an arbitrary body.
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

export interface WebhookEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

export type RpcResult = { data: unknown; error: { message?: string } | null };

export interface WebhookDeps {
  /** STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and the service role all present. */
  configured: boolean;
  /** Raw request body, or null when it exceeded MAX_WEBHOOK_BODY_BYTES. */
  rawBody: string | null;
  signature: string | null;
  /** stripe.webhooks.constructEvent bound to the webhook secret; throws on a bad signature. */
  constructEvent(rawBody: string, signature: string): WebhookEvent;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
  /** Sends the order confirmation. Runs only when a payment was newly applied,
   * so a redelivered event (a 'duplicate') never emails twice. */
  onOrderPaid?(sessionId: string): Promise<unknown>;
}

export interface WebhookResult {
  status: number;
  body: { received: true } | { error: string };
}

const OK: WebhookResult = { status: 200, body: { received: true } };

export interface OrderAddress {
  name: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
}

interface LooseShipping {
  name?: unknown;
  address?: Record<string, unknown> | null;
}

interface LooseSession {
  id?: unknown;
  payment_status?: unknown;
  payment_intent?: unknown;
  amount_total?: unknown;
  currency?: unknown;
  // Newer API versions (including the pinned one) put shipping here...
  collected_information?: { shipping_details?: LooseShipping | null } | null;
  // ...older ones put it at the top level. Both are read so a version change
  // in either direction cannot silently drop the address.
  shipping_details?: LooseShipping | null;
}

interface LooseCharge {
  payment_intent?: unknown;
  refunded?: unknown;
}

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** Expandable Stripe fields arrive as an id string or an object with an id. */
function idOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return str(value);
  }
  if (value && typeof value === 'object' && 'id' in value) {
    return str((value as { id: unknown }).id);
  }
  return null;
}

/** Flat order address from either session shipping shape; null when absent. */
export function mapShippingAddress(session: LooseSession): OrderAddress | null {
  const shipping = session.collected_information?.shipping_details ?? session.shipping_details;
  if (!shipping) {
    return null;
  }
  const a = shipping.address ?? {};
  return {
    name: str(shipping.name),
    line1: str(a.line1),
    line2: str(a.line2),
    city: str(a.city),
    state: str(a.state),
    postal_code: str(a.postal_code),
    country: str(a.country),
  };
}

async function call(
  deps: WebhookDeps,
  fn: string,
  args: Record<string, unknown>,
): Promise<WebhookResult> {
  const { error } = await deps.rpc(fn, args);
  return error ? failed(fn, error) : OK;
}

function failed(fn: string, error: { message?: string }): WebhookResult {
  // Logged server-side for operators; the response carries nothing.
  console.error(`stripe webhook: ${fn} failed: ${error.message ?? 'unknown error'}`);
  return { status: 500, body: { error: 'processing_failed' } };
}

export async function handleStripeWebhook(deps: WebhookDeps): Promise<WebhookResult> {
  if (!deps.configured) {
    return { status: 501, body: { error: 'payments_not_configured' } };
  }
  if (deps.rawBody === null || !deps.signature) {
    return { status: 400, body: { error: 'invalid_signature' } };
  }

  let event: WebhookEvent;
  try {
    event = deps.constructEvent(deps.rawBody, deps.signature);
  } catch {
    return { status: 400, body: { error: 'invalid_signature' } };
  }

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as LooseSession;
      // A completed session with a delayed method is still 'unpaid'; the
      // async_payment_succeeded event that follows carries the payment.
      if (session.payment_status !== 'paid') {
        return OK;
      }
      const sessionId = str(session.id);
      const { data, error } = await deps.rpc('stripe_checkout_completed', {
        p_event_id: event.id,
        p_session_id: sessionId,
        p_payment_intent: idOf(session.payment_intent),
        p_amount_cents: typeof session.amount_total === 'number' ? session.amount_total : null,
        p_currency: str(session.currency),
        p_address: mapShippingAddress(session),
      });
      if (error) {
        return failed('stripe_checkout_completed', error);
      }
      if (data === 'applied' && sessionId && deps.onOrderPaid) {
        // The payment is committed; an email problem must not make Stripe
        // retry (the retry would be a duplicate and send nothing anyway).
        await deps.onOrderPaid(sessionId).catch(() => undefined);
      }
      return OK;
    }
    case 'checkout.session.expired': {
      const session = event.data.object as LooseSession;
      return call(deps, 'stripe_checkout_expired', {
        p_event_id: event.id,
        p_session_id: str(session.id),
      });
    }
    case 'charge.refunded': {
      const charge = event.data.object as LooseCharge;
      return call(deps, 'stripe_charge_refunded', {
        p_event_id: event.id,
        p_payment_intent: idOf(charge.payment_intent),
        p_fully_refunded: charge.refunded === true,
      });
    }
    default:
      return OK;
  }
}
