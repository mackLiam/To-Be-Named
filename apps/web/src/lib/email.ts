import type { SupabaseClient } from '@supabase/supabase-js';

import { BRAND_NAME } from '@forms/shared/brand';

import { formatMoney } from './shop';

/**
 * Transactional email via the Resend REST API. An email failure must never
 * fail an order transition, so nothing here throws on provider problems.
 * Never log addresses, bodies, or the key.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailDeps {
  fetch: typeof fetch;
  apiKey: string | undefined;
  from: string | undefined;
}

export type EmailResult =
  { sent: true } | { sent: false; reason: 'not_configured' | 'provider_error' | 'lookup_failed' };

export function emailDepsFromEnv(): EmailDeps {
  return {
    fetch: (...args) => fetch(...args),
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.EMAIL_FROM,
  };
}

export async function sendEmail(deps: EmailDeps, message: EmailMessage): Promise<EmailResult> {
  if (!deps.apiKey || !deps.from) {
    console.log('email skipped: not configured');
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const res = await deps.fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: deps.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!res.ok) {
      console.log(`email failed: provider returned ${res.status}`);
      return { sent: false, reason: 'provider_error' };
    }
    return { sent: true };
  } catch {
    console.log('email failed: provider unreachable');
    return { sent: false, reason: 'provider_error' };
  }
}

function reference(orderId: string): string {
  return orderId.slice(0, 8).toUpperCase();
}

const CLOSING = 'Replies to this email reach our support team.';

export function orderConfirmedEmail(o: {
  orderId: string;
  productName: string;
  amountCents: number;
  currency: string;
}): { subject: string; text: string } {
  const ref = reference(o.orderId);
  return {
    subject: `${BRAND_NAME} order ${ref} confirmed`,
    text: [
      `Thanks for your order. We have received your payment of ${formatMoney(o.amountCents, o.currency)} for ${o.productName}.`,
      `Your order reference is ${ref}.`,
      'We will email you again when it ships.',
      CLOSING,
    ].join('\n\n'),
  };
}

export function orderShippedEmail(o: {
  orderId: string;
  productName: string;
  trackingCarrier: string | null;
  trackingNumber: string | null;
}): { subject: string; text: string } {
  const ref = reference(o.orderId);
  const tracking = o.trackingNumber
    ? `Tracking: ${[o.trackingCarrier, o.trackingNumber].filter(Boolean).join(' ')}.`
    : 'Tracking details are not available yet.';
  return {
    subject: `${BRAND_NAME} order ${ref} has shipped`,
    text: [
      `Your ${o.productName} has shipped.`,
      `Your order reference is ${ref}.`,
      tracking,
      CLOSING,
    ].join('\n\n'),
  };
}

/** Lookup failures return a result instead of throwing, like send failures. */
export async function notifyOrderShipped(
  client: SupabaseClient,
  orderId: string,
  deps: EmailDeps,
): Promise<EmailResult> {
  try {
    const { data: order, error } = await client
      .from('orders')
      .select('id, user_id, tracking_carrier, tracking_number, products(name)')
      .eq('id', orderId)
      .maybeSingle();
    if (error || !order) {
      return { sent: false, reason: 'lookup_failed' };
    }
    const { data: user, error: userError } = await client.auth.admin.getUserById(order.user_id);
    const to = user?.user?.email;
    if (userError || !to) {
      return { sent: false, reason: 'lookup_failed' };
    }
    const product = order.products as { name: string } | { name: string }[] | null;
    const productName = (Array.isArray(product) ? product[0]?.name : product?.name) ?? 'order';
    const { subject, text } = orderShippedEmail({
      orderId: order.id,
      productName,
      trackingCarrier: order.tracking_carrier,
      trackingNumber: order.tracking_number,
    });
    return await sendEmail(deps, { to, subject, text });
  } catch {
    return { sent: false, reason: 'lookup_failed' };
  }
}

/** Confirmation for an order the paid webhook just applied, found by its
 * Checkout Session id. Never throws, like notifyOrderShipped. */
export async function notifyOrderConfirmed(
  client: SupabaseClient,
  sessionId: string,
  deps: EmailDeps,
): Promise<EmailResult> {
  try {
    const { data: order, error } = await client
      .from('orders')
      .select('id, user_id, amount_cents, products(name, currency)')
      .eq('stripe_checkout_session_id', sessionId)
      .maybeSingle();
    if (error || !order || order.amount_cents == null) {
      return { sent: false, reason: 'lookup_failed' };
    }
    const { data: user, error: userError } = await client.auth.admin.getUserById(order.user_id);
    const to = user?.user?.email;
    if (userError || !to) {
      return { sent: false, reason: 'lookup_failed' };
    }
    const joined = order.products as
      { name: string; currency: string } | { name: string; currency: string }[] | null;
    const product = Array.isArray(joined) ? joined[0] : joined;
    const { subject, text } = orderConfirmedEmail({
      orderId: order.id,
      productName: product?.name ?? 'order',
      amountCents: order.amount_cents,
      currency: product?.currency ?? 'usd',
    });
    return await sendEmail(deps, { to, subject, text });
  } catch {
    return { sent: false, reason: 'lookup_failed' };
  }
}
