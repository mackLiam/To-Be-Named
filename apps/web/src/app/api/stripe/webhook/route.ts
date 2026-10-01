import { emailDepsFromEnv, notifyOrderConfirmed } from '@/lib/email';
import { getStripeSecretKey, getStripeWebhookSecret, hasServiceRoleConfig } from '@/lib/env';
import { readCappedText } from '@/lib/checkout';
import { createStripeClient } from '@/lib/stripe';
import { MAX_WEBHOOK_BODY_BYTES, handleStripeWebhook } from '@/lib/stripe-webhook';
import { createServiceRoleClient } from '@/lib/supabase-admin';

/**
 * Thin adapter over handleStripeWebhook (lib/stripe-webhook.ts, unit tested).
 * The body is read raw: signature verification is over the exact bytes Stripe
 * sent, so it must never be parsed and re-serialized first.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const secret = getStripeWebhookSecret();
  const configured = Boolean(getStripeSecretKey() && secret && hasServiceRoleConfig());

  let result;
  try {
    result = await handleStripeWebhook({
      configured,
      rawBody: configured ? await readCappedText(request.body, MAX_WEBHOOK_BODY_BYTES) : null,
      signature: request.headers.get('stripe-signature'),
      constructEvent: (body, signature) =>
        createStripeClient().webhooks.constructEvent(body, signature, secret!),
      rpc: (fn, args) => createServiceRoleClient().rpc(fn, args),
      onOrderPaid: (sessionId) =>
        notifyOrderConfirmed(createServiceRoleClient(), sessionId, emailDepsFromEnv()),
    });
  } catch (err) {
    console.error('stripe webhook failed:', err instanceof Error ? err.message : 'unknown error');
    result = { status: 500, body: { error: 'processing_failed' } };
  }

  return Response.json(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store' },
  });
}
