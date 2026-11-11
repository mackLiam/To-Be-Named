/**
 * Admin customer lookup (migration 0026 admin_find_customers). Pure parsing
 * and wording; the read itself is searchCustomers in data.ts.
 *
 * A deleted account has no auth user, so no email to search by: its orders
 * keep user_id null (0012) and are found by order reference instead.
 */

import type { CustomerRow } from './types';

/** Same bounds as admin_find_customers (0026). */
export const MIN_CUSTOMER_QUERY = 3;
export const MAX_CUSTOMER_QUERY = 320;

export type CustomerQuery =
  | { kind: 'empty' }
  | { kind: 'invalid'; error: string }
  | { kind: 'search'; email: string; exact: boolean };

export function parseCustomerQuery(
  rawEmail: string | undefined,
  rawMatch: string | undefined,
): CustomerQuery {
  const email = (rawEmail ?? '').trim().toLowerCase();
  if (!email) {
    return { kind: 'empty' };
  }
  if (email.length < MIN_CUSTOMER_QUERY || email.length > MAX_CUSTOMER_QUERY) {
    return {
      kind: 'invalid',
      error: `Type at least ${MIN_CUSTOMER_QUERY} characters of the email (at most ${MAX_CUSTOMER_QUERY}).`,
    };
  }
  if (/\s/.test(email)) {
    return { kind: 'invalid', error: 'An email has no spaces.' };
  }
  return { kind: 'search', email, exact: rawMatch === 'exact' };
}

export function accountStateLabel(
  row: Pick<CustomerRow, 'is_anonymous' | 'deletion_requested_at' | 'deletion_reason'>,
): string {
  if (row.deletion_requested_at) {
    return row.deletion_reason === 'user_request'
      ? 'Deletion requested'
      : `Deletion queued (${(row.deletion_reason ?? 'unknown').replace(/_/g, ' ')})`;
  }
  return row.is_anonymous ? 'Guest' : 'Member';
}

const SCAN_STATUS_ORDER = ['ready', 'processing', 'uploaded', 'capturing', 'failed'];

/** "2 ready, 1 failed", stable order; "none" for no scans. */
export function scanSummary(statuses: Record<string, number> | null | undefined): string {
  const entries = Object.entries(statuses ?? {}).filter(([, n]) => n > 0);
  if (entries.length === 0) {
    return 'none';
  }
  const rank = (status: string) => {
    const i = SCAN_STATUS_ORDER.indexOf(status);
    return i === -1 ? SCAN_STATUS_ORDER.length : i;
  };
  return entries
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([status, n]) => `${n} ${status}`)
    .join(', ');
}

/** Numbers arrive from PostgREST as numbers or, for bigint, strings. */
export function normalizeCustomerRow(raw: Record<string, unknown>): CustomerRow {
  const n = (value: unknown) => {
    const parsed = typeof value === 'string' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : 0;
  };
  const statuses: Record<string, number> = {};
  if (raw.scan_statuses && typeof raw.scan_statuses === 'object') {
    for (const [key, value] of Object.entries(raw.scan_statuses as Record<string, unknown>)) {
      statuses[key] = n(value);
    }
  }
  return {
    user_id: String(raw.user_id),
    email: String(raw.email ?? ''),
    is_anonymous: raw.is_anonymous === true,
    created_at: String(raw.created_at ?? ''),
    deletion_requested_at:
      typeof raw.deletion_requested_at === 'string' ? raw.deletion_requested_at : null,
    deletion_reason: typeof raw.deletion_reason === 'string' ? raw.deletion_reason : null,
    order_count: n(raw.order_count),
    open_order_count: n(raw.open_order_count),
    scan_count: n(raw.scan_count),
    scan_statuses: statuses,
  };
}
