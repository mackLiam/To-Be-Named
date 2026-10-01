/**
 * Shop admin rules: product form validation and the order status machine the
 * admin panel is allowed to drive. Pure (no IO, no framework), so the server
 * actions stay thin and every rule here is unit tested in shop.test.ts.
 */

import { ORDER_STATUSES, validateCadModelDescriptor, type OrderStatus } from '@forms/shared';

import type { StatusMeta } from './view';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route params reach Postgres uuid columns; a malformed one is a 404, not a 500. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// ---------------------------------------------------------------------------
// Products.
// ---------------------------------------------------------------------------

export interface ProductInput {
  name: string;
  slug: string;
  description: string;
  base_price_cents: number;
  currency: string;
  image_url: string | null;
  active: boolean;
  cad_model: Record<string, unknown> | null;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Upper bound is a typo guard (an extra zero), not a business rule.
const MAX_PRICE_CENTS = 100_000;

/**
 * "89" or "89.00" -> 8900. Rejects anything that is not a plain non-negative
 * amount with at most two decimals, so no float rounding reaches the DB.
 */
export function parsePriceToCents(raw: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export function centsToPriceInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Field values as a form posts them. A missing checkbox is "off". */
export function parseProductForm(
  form: Record<string, string | undefined>,
): ParseResult<ProductInput> {
  const errors: string[] = [];
  const name = (form.name ?? '').trim();
  const slug = (form.slug ?? '').trim();
  const description = (form.description ?? '').trim();
  const currency = (form.currency ?? 'usd').trim().toLowerCase();
  const imageUrl = (form.image_url ?? '').trim();
  const cadRaw = (form.cad_model ?? '').trim();

  if (!name || name.length > 120) {
    errors.push('Name is required (at most 120 characters).');
  }
  if (!SLUG_RE.test(slug) || slug.length > 80) {
    errors.push('Slug must be lowercase letters, numbers and single hyphens, e.g. custom-guard.');
  }
  if (description.length > 600) {
    errors.push('Description must be at most 600 characters.');
  }
  const cents = parsePriceToCents(form.price ?? '');
  if (cents === null || cents > MAX_PRICE_CENTS) {
    errors.push('Price must be an amount like 89 or 89.00, at most 1000.00.');
  }
  if (!/^[a-z]{3}$/.test(currency)) {
    errors.push('Currency must be a three-letter code, e.g. usd.');
  }
  if (imageUrl && (!/^https:\/\/\S+$/.test(imageUrl) || imageUrl.length > 500)) {
    errors.push('Image URL must start with https://.');
  }

  let cadModel: Record<string, unknown> | null = null;
  if (cadRaw) {
    try {
      const parsed: unknown = JSON.parse(cadRaw);
      const cadErrors = validateCadModelDescriptor(parsed);
      if (cadErrors.length > 0) {
        errors.push(...cadErrors.map((e) => `CAD model ${e}`));
      } else {
        cadModel = parsed as Record<string, unknown>;
      }
    } catch {
      errors.push('CAD model must be valid JSON, or empty to use the worker default.');
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      name,
      slug,
      description,
      base_price_cents: cents!,
      currency,
      image_url: imageUrl || null,
      active: form.active === 'on',
      cad_model: cadModel,
    },
  };
}

// ---------------------------------------------------------------------------
// Orders.
// ---------------------------------------------------------------------------

/**
 * What an admin may move an order to. 'paid' from pending_payment is the
 * manual path while Stripe is deferred (CLAUDE.md "Current phase"); once the
 * webhook exists it sets paid itself and this edge stays as the override.
 * delivered and cancelled are terminal.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['in_production', 'cancelled'],
  in_production: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export const ORDER_STATUS_META: Record<OrderStatus, StatusMeta> = {
  pending_payment: { label: 'Awaiting payment', tone: 'neutral' },
  paid: { label: 'Paid', tone: 'warn' },
  in_production: { label: 'In production', tone: 'progress' },
  shipped: { label: 'Shipped', tone: 'progress' },
  delivered: { label: 'Delivered', tone: 'good' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
};

export function isOrderStatus(value: string | null | undefined): value is OrderStatus {
  return value != null && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function orderStatusMeta(status: string): StatusMeta {
  return isOrderStatus(status) ? ORDER_STATUS_META[status] : { label: status, tone: 'neutral' };
}

export function nextOrderStatuses(status: string): readonly OrderStatus[] {
  return isOrderStatus(status) ? ORDER_TRANSITIONS[status] : [];
}

/**
 * Null when the move is allowed, otherwise the reason. Shipping requires a
 * tracking number so the customer is never told "shipped" with nothing to
 * follow.
 */
export function checkOrderTransition(
  from: string,
  to: string,
  opts: { trackingNumber: string | null },
): string | null {
  if (!isOrderStatus(to)) {
    return `Unknown status "${to}".`;
  }
  if (!nextOrderStatuses(from).includes(to)) {
    return `An order that is ${orderStatusMeta(from).label.toLowerCase()} cannot move to ${ORDER_STATUS_META[to].label.toLowerCase()}.`;
  }
  if (to === 'shipped' && !opts.trackingNumber?.trim()) {
    return 'Add a tracking number before marking the order shipped.';
  }
  return null;
}

export function parseTrackingForm(
  form: Record<string, string | undefined>,
): ParseResult<{ tracking_carrier: string | null; tracking_number: string | null }> {
  const carrier = (form.tracking_carrier ?? '').trim();
  const number = (form.tracking_number ?? '').trim();
  const errors: string[] = [];
  if (carrier.length > 40) {
    errors.push('Carrier must be at most 40 characters.');
  }
  if (number && !/^[A-Za-z0-9 -]{4,40}$/.test(number)) {
    errors.push('Tracking number must be 4 to 40 letters, digits, spaces or hyphens.');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: { tracking_carrier: carrier || null, tracking_number: number || null },
  };
}

/** Button copy for each move an admin can make. */
export const ORDER_ACTION_LABEL: Record<OrderStatus, string> = {
  pending_payment: 'Back to awaiting payment',
  paid: 'Mark paid (manual)',
  in_production: 'Start production',
  shipped: 'Mark shipped',
  delivered: 'Mark delivered',
  cancelled: 'Cancel order',
};

const ADDRESS_KEYS = ['name', 'line1', 'line2', 'city', 'state', 'postal_code', 'country'];

/**
 * orders.address is JSONB written by checkout (Stripe's address shape).
 * Read defensively: only known string fields, in mailing order, one per line.
 */
export function formatAddress(address: Record<string, unknown> | null | undefined): string {
  if (!address) {
    return '';
  }
  return ADDRESS_KEYS.map((key) => address[key])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.trim())
    .join('\n');
}

/** One line per audit row on the order history. */
export function describeAudit(row: {
  action: string;
  detail: Record<string, unknown> | null;
}): string {
  const d = row.detail ?? {};
  if (row.action === 'order.status' && typeof d.from === 'string' && typeof d.to === 'string') {
    return `${orderStatusMeta(d.from).label} to ${orderStatusMeta(d.to).label}`;
  }
  if (row.action === 'order.tracking') {
    const number = typeof d.tracking_number === 'string' ? d.tracking_number : null;
    const carrier = typeof d.tracking_carrier === 'string' ? `${d.tracking_carrier} ` : '';
    return number ? `Tracking set to ${carrier}${number}` : 'Tracking cleared';
  }
  return row.action;
}

export function formatMoney(cents: number | null, currency: string | null): string {
  if (cents == null) {
    return '-';
  }
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: (currency ?? 'usd').toUpperCase(),
  });
}
