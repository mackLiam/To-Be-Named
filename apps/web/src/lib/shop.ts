/**
 * Shop admin rules: product form validation and the order status machine the
 * admin panel is allowed to drive. Pure (no IO, no framework), so the server
 * actions stay thin and every rule here is unit tested in shop.test.ts.
 */

import { ORDER_STATUSES, validateCadModelDescriptor, type OrderStatus } from '@forms/shared';

import {
  isAvailability,
  normalizeSizingModes,
  type Availability,
  type SizingMode,
} from './catalog';
import { parseCents } from './money';
import { shortId, type StatusMeta } from './view';

export { isUuid } from './ids';
export { formatMoney, parseCents } from './money';

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
  display_order: number;
  availability: Availability;
  sizing_modes: SizingMode[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Upper bound is a typo guard (an extra zero), not a business rule.
const MAX_PRICE_CENTS = 100_000;
// Matches products_display_order_range (0022).
export const MAX_DISPLAY_ORDER = 100_000;

/**
 * Field values as a form posts them. A missing checkbox is "off". Sizing
 * modes arrive as one `sizing_modes` field per checked box, so the caller
 * passes them separately (FormData.getAll).
 */
export function parseProductForm(
  form: Record<string, string | undefined>,
  sizingModes: readonly string[] = ['custom'],
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
  const cents = parseCents(form.base_price_cents);
  if (cents === null || cents > MAX_PRICE_CENTS) {
    errors.push('Price must be whole cents, e.g. 8900 for 89.00, at most 100000.');
  }
  const displayOrder = parseCents(form.display_order || '0');
  if (displayOrder === null || displayOrder > MAX_DISPLAY_ORDER) {
    errors.push(`Display order must be a whole number from 0 to ${MAX_DISPLAY_ORDER}.`);
  }
  const availability = (form.availability ?? '').trim();
  if (!isAvailability(availability)) {
    errors.push('Availability must be available, coming soon or paused.');
  }
  const modes = normalizeSizingModes(sizingModes);
  if (modes.length === 0 || modes.length !== new Set(sizingModes).size) {
    errors.push('Choose at least one sizing mode, from the listed ones only.');
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
      errors.push('CAD model must be valid JSON, or empty.');
    }
  }

  // Purchasable needs a model the pipeline can build (0022
  // products_available_needs_cad_model; the paid trigger refuses without one)
  // and a price Stripe can charge.
  if (availability === 'available') {
    if (!cadRaw) {
      errors.push('Add a CAD model descriptor before making the product available.');
    }
    if (cents === 0) {
      errors.push('A product must cost more than 0 to be available.');
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
      display_order: displayOrder!,
      availability: availability as Availability,
      sizing_modes: modes,
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
  if (row.action === 'order.refund') {
    return typeof d.refund_status === 'string'
      ? `Refund issued (${d.refund_status})`
      : 'Refund issued';
  }
  if (row.action === 'order.tracking') {
    const number = typeof d.tracking_number === 'string' ? d.tracking_number : null;
    const carrier = typeof d.tracking_carrier === 'string' ? `${d.tracking_carrier} ` : '';
    return number ? `Tracking set to ${carrier}${number}` : 'Tracking cleared';
  }
  return row.action;
}

/**
 * The reference customers quote (first 8 hex chars of the order id, as the
 * emails print it) -> the id range it covers. uuid ordering in Postgres is
 * bytewise, so this range is exactly the ids with that prefix.
 */
export function orderReferenceRange(raw: string | undefined): { from: string; to: string } | null {
  const ref = (raw ?? '').trim().toLowerCase().replace(/^#/, '');
  if (!/^[0-9a-f]{8}$/.test(ref)) {
    return null;
  }
  return { from: `${ref}-0000-0000-0000-000000000000`, to: `${ref}-ffff-ffff-ffff-ffffffffffff` };
}

/** Who placed the order, for the admin. user_id is null after account deletion (0012). */
export function customerLabel(order: {
  customer_email: string | null;
  user_id: string | null;
}): string {
  if (order.customer_email) {
    return order.customer_email;
  }
  return order.user_id ? shortId(order.user_id) : 'Deleted account';
}
