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
  | { sent: true }
  | {
      sent: false;
      reason: 'not_configured' | 'provider_error' | 'lookup_failed' | 'not_applicable';
    };

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

// ---------------------------------------------------------------------------
// Refund, cancellation, remake and rescan emails. Plain, short, and with no
// promise about timelines or policy: where one would be needed there is a
// TODO(liam) here and nothing in the email.
// ---------------------------------------------------------------------------

export function refundIssuedEmail(o: {
  orderId: string;
  amountCents: number;
  currency: string;
  full: boolean;
  cancelled: boolean;
}): { subject: string; text: string } {
  const ref = reference(o.orderId);
  // TODO(liam): whether to say how long a refund takes to reach the card. It
  // depends on the bank, so it is left out rather than guessed.
  return {
    subject: `${BRAND_NAME} order ${ref}: refund issued`,
    text: [
      o.full
        ? `We have refunded your payment of ${formatMoney(o.amountCents, o.currency)} for order ${ref}.`
        : `We have issued a partial refund of ${formatMoney(o.amountCents, o.currency)} for order ${ref}.`,
      o.cancelled ? 'Your order has been cancelled.' : null,
      'The refund goes back to the payment method you used.',
      CLOSING,
    ]
      .filter((line): line is string => line !== null)
      .join('\n\n'),
  };
}

export function orderCancelledEmail(o: { orderId: string; productName: string }): {
  subject: string;
  text: string;
} {
  const ref = reference(o.orderId);
  // TODO(liam): what to tell the customer about money on a cancelled order.
  // Cancelling does not refund by itself (a refund sends its own email), so
  // this email makes no statement about refunds.
  return {
    subject: `${BRAND_NAME} order ${ref} cancelled`,
    text: [`Your order ${ref} for ${o.productName} has been cancelled.`, CLOSING].join('\n\n'),
  };
}

export function remakeStartedEmail(o: {
  orderId: string;
  originalOrderId: string;
  productName: string;
}): { subject: string; text: string } {
  const ref = reference(o.orderId);
  const original = reference(o.originalOrderId);
  // TODO(liam): whether the customer must return the original guard. Not
  // mentioned until decided.
  return {
    subject: `${BRAND_NAME} order ${original}: we are making a replacement`,
    text: [
      `We are making a replacement ${o.productName} for your order ${original}. There is nothing to pay.`,
      `The replacement has its own order reference, ${ref}.`,
      'We will email you again when it ships.',
      CLOSING,
    ].join('\n\n'),
  };
}

export function rescanNeededEmail(o: { orderId?: string | null } = {}): {
  subject: string;
  text: string;
} {
  // TODO(liam): link to scanning tips once a help page exists.
  return {
    subject: `${BRAND_NAME}: please scan again`,
    text: [
      'We could not take reliable measurements from your recent scan, so we need a new one before we can make your guards.',
      o.orderId ? `This is about your order ${reference(o.orderId)}.` : null,
      'You can scan again in the app whenever it suits you.',
      CLOSING,
    ]
      .filter((line): line is string => line !== null)
      .join('\n\n'),
  };
}

type AuthAdmin = SupabaseClient['auth']['admin'];

/** Orders outlive accounts (0012): a null user_id never reaches the auth API. */
async function customerEmail(admin: AuthAdmin, userId: string | null): Promise<string | null> {
  if (!userId) {
    return null;
  }
  const { data, error } = await admin.getUserById(userId);
  return error ? null : (data?.user?.email ?? null);
}

interface OrderForEmail {
  id: string;
  user_id: string | null;
  paid_at: string | null;
  remake_of: string | null;
  productName: string;
}

async function loadOrderForEmail(
  client: SupabaseClient,
  orderId: string,
): Promise<OrderForEmail | null> {
  const { data, error } = await client
    .from('orders')
    .select('id, user_id, paid_at, remake_of, products(name)')
    .eq('id', orderId)
    .maybeSingle();
  if (error || !data) {
    return null;
  }
  const joined = data.products as { name: string } | { name: string }[] | null;
  const name = (Array.isArray(joined) ? joined[0]?.name : joined?.name) ?? 'order';
  return {
    id: data.id as string,
    user_id: (data.user_id as string | null) ?? null,
    paid_at: (data.paid_at as string | null) ?? null,
    remake_of: (data.remake_of as string | null) ?? null,
    productName: name,
  };
}

/** Shared shell: load, resolve the address, build, send. Never throws. */
async function notifyOrder(
  client: SupabaseClient,
  orderId: string,
  deps: EmailDeps,
  build: (order: OrderForEmail) => { subject: string; text: string } | null,
): Promise<EmailResult> {
  try {
    const order = await loadOrderForEmail(client, orderId);
    if (!order) {
      return { sent: false, reason: 'lookup_failed' };
    }
    const message = build(order);
    if (!message) {
      return { sent: false, reason: 'not_applicable' };
    }
    const to = await customerEmail(client.auth.admin, order.user_id);
    if (!to) {
      return { sent: false, reason: 'lookup_failed' };
    }
    return await sendEmail(deps, { to, ...message });
  } catch {
    return { sent: false, reason: 'lookup_failed' };
  }
}

export function notifyRefundIssued(
  client: SupabaseClient,
  orderId: string,
  refund: { amountCents: number; currency: string; full: boolean; cancelled: boolean },
  deps: EmailDeps,
): Promise<EmailResult> {
  return notifyOrder(client, orderId, deps, (order) =>
    refundIssuedEmail({ orderId: order.id, ...refund }),
  );
}

/** Only for an order that was paid: an abandoned checkout gets no email. */
export function notifyOrderCancelled(
  client: SupabaseClient,
  orderId: string,
  deps: EmailDeps,
): Promise<EmailResult> {
  return notifyOrder(client, orderId, deps, (order) =>
    order.paid_at
      ? orderCancelledEmail({ orderId: order.id, productName: order.productName })
      : null,
  );
}

export function notifyRemakeStarted(
  client: SupabaseClient,
  remakeOrderId: string,
  deps: EmailDeps,
): Promise<EmailResult> {
  return notifyOrder(client, remakeOrderId, deps, (order) =>
    order.remake_of
      ? remakeStartedEmail({
          orderId: order.id,
          originalOrderId: order.remake_of,
          productName: order.productName,
        })
      : null,
  );
}

/**
 * Rescan request to a scan's owner. Not wired yet: the measurement gate
 * failure is raised by the pipeline (services/pipeline), which will call this
 * path once it can reach the web app or send mail itself.
 */
export async function notifyRescanNeeded(
  client: SupabaseClient,
  userId: string | null,
  deps: EmailDeps,
  orderId: string | null = null,
): Promise<EmailResult> {
  try {
    const to = await customerEmail(client.auth.admin, userId);
    if (!to) {
      return { sent: false, reason: 'lookup_failed' };
    }
    return await sendEmail(deps, { to, ...rescanNeededEmail({ orderId }) });
  } catch {
    return { sent: false, reason: 'lookup_failed' };
  }
}

export const EMAIL_TEMPLATES = [
  'order_shipped',
  'order_cancelled',
  'refund_issued',
  'remake_started',
  'rescan_needed',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

/** audit_log detail for an email attempt; never the address or body. */
export function emailAuditDetail(
  template: EmailTemplate,
  result: EmailResult,
): { template: EmailTemplate; sent: boolean; reason: string | null } {
  return { template, sent: result.sent, reason: result.sent ? null : result.reason };
}
