import type { SupabaseClient } from '@supabase/supabase-js';

import type { ParseResult } from './shop';
import { isUuid } from './ids';

/**
 * Admin remakes (migration 0024). A remake is a new zero-cost order linked to
 * the original by remake_of; create_order_remake creates it already paid, so
 * the existing paid trigger enqueues its CAD jobs from the same scans and
 * stored measurements. Nothing here touches Stripe.
 *
 * TODO(liam): remake versus refund policy (who qualifies, time window, who
 * pays return shipping). The panel offers the action; the policy decides when.
 */

/** Mirrors orders_remake_reason_check (0024). */
export const REMAKE_REASONS = [
  'fit_too_tight',
  'fit_too_loose',
  'print_defect',
  'damaged_in_transit',
  'wrong_item',
  'other',
] as const;
export type RemakeReason = (typeof REMAKE_REASONS)[number];

export const REMAKE_REASON_LABEL: Record<RemakeReason, string> = {
  fit_too_tight: 'Fit too tight',
  fit_too_loose: 'Fit too loose',
  print_defect: 'Print defect',
  damaged_in_transit: 'Damaged in transit',
  wrong_item: 'Wrong item sent',
  other: 'Other',
};

export const REMAKE_LEGS = ['both', 'left', 'right'] as const;
export type RemakeLegs = (typeof REMAKE_LEGS)[number];

/** Matches the create_order_remake note limit (0024). */
export const MAX_REMAKE_NOTE = 500;

/** Only these may be remade (create_order_remake refuses the rest). */
const REMAKEABLE: readonly string[] = ['shipped', 'delivered'];

export function isRemakeReason(value: string | null | undefined): value is RemakeReason {
  return value != null && (REMAKE_REASONS as readonly string[]).includes(value);
}

export function remakeReasonLabel(value: string | null | undefined): string {
  return isRemakeReason(value) ? REMAKE_REASON_LABEL[value] : (value ?? '');
}

/**
 * Fit reasons may mean the measurements themselves were wrong, in which case
 * the same scans would print the same guard again.
 * TODO(liam): should a fit remake require the customer to rescan first? Until
 * decided, the remake reuses the original scans and the panel says so.
 */
export function isFitReason(reason: RemakeReason): boolean {
  return reason === 'fit_too_tight' || reason === 'fit_too_loose';
}

export interface RemakeableOrder {
  status: string;
  user_id: string | null;
  /** A pending account deletion request (0012); create_order_remake refuses it. */
  deletion_pending: boolean;
}

/** Whether the order page offers "Remake". */
export function canRemake(order: RemakeableOrder): boolean {
  return REMAKEABLE.includes(order.status) && order.user_id !== null && !order.deletion_pending;
}

export type RemakeState =
  { kind: 'offer' } | { kind: 'open'; remakeId: string } | { kind: 'unavailable'; reason: string };

/** What the order page shows in its Remake section. */
export function remakeState(
  order: RemakeableOrder & { remakes: readonly { id: string; status: string }[] },
): RemakeState {
  const open = order.remakes.find((r) => r.status !== 'cancelled');
  if (open) {
    return { kind: 'open', remakeId: open.id };
  }
  if (order.user_id === null) {
    return { kind: 'unavailable', reason: 'The customer deleted their account, so no remake.' };
  }
  if (order.deletion_pending) {
    return {
      kind: 'unavailable',
      reason: 'The customer asked to delete their account, so no remake.',
    };
  }
  if (!REMAKEABLE.includes(order.status)) {
    return { kind: 'unavailable', reason: 'A remake is possible once the order has shipped.' };
  }
  return { kind: 'offer' };
}

/** Which leg choices make sense for this order. */
export function remakeLegOptions(order: {
  scan_id_left: string | null;
  scan_id_right: string | null;
}): RemakeLegs[] {
  if (order.scan_id_left && order.scan_id_right) {
    return ['both', 'left', 'right'];
  }
  return ['both'];
}

export interface RemakeInput {
  orderId: string;
  reason: RemakeReason;
  note: string | null;
  legs: RemakeLegs;
}

export function parseRemakeForm(
  form: Record<string, string | undefined>,
): ParseResult<RemakeInput> {
  const errors: string[] = [];
  const orderId = (form.id ?? '').trim();
  const reason = (form.reason ?? '').trim();
  const legs = (form.legs ?? 'both').trim();
  const note = (form.note ?? '').trim();

  if (!isUuid(orderId)) {
    errors.push('Unknown order.');
  }
  if (!isRemakeReason(reason)) {
    errors.push('Choose a reason for the remake.');
  }
  if (!(REMAKE_LEGS as readonly string[]).includes(legs)) {
    errors.push('Choose which legs to remake.');
  }
  if (note.length > MAX_REMAKE_NOTE) {
    errors.push(`The note must be at most ${MAX_REMAKE_NOTE} characters.`);
  }
  if (reason === 'other' && !note) {
    errors.push('Describe the reason when it is Other.');
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      orderId: orderId.toLowerCase(),
      reason: reason as RemakeReason,
      note: note || null,
      legs: legs as RemakeLegs,
    },
  };
}

/** Fixed admin-facing outcomes of createRemake (admin-messages.ts maps them to codes). */
export const REMAKE_MESSAGES = {
  orderNotFound: 'Order not found.',
  refusedStatus: 'Remake refused: only a shipped or delivered order can be remade.',
  refusedDeleted: 'Remake refused: the customer deleted their account.',
  refusedDeleting: 'Remake refused: the customer asked to delete their account.',
  refusedProduction:
    'Remake refused: the product has no CAD model or a scan has no measurements. Fix that, then try again.',
  refusedInput: 'Remake refused: the form was not valid. Reload the page and try again.',
  alreadyOpen: 'This order already has an open remake. Reload to see it.',
} as const;

/**
 * create_order_remake's 23514 refusals (0024) by their fixed message text.
 * Anything else with that code comes from the paid trigger (0008, 0016):
 * no CAD model, or a scan without measurements.
 */
function remakeRefusal(message: string | undefined): string {
  const text = message ?? '';
  if (text.startsWith('only a shipped or delivered order can be remade')) {
    return REMAKE_MESSAGES.refusedStatus;
  }
  if (text === 'the customer deleted their account') {
    return REMAKE_MESSAGES.refusedDeleted;
  }
  if (text === 'the customer asked to delete their account') {
    return REMAKE_MESSAGES.refusedDeleting;
  }
  return REMAKE_MESSAGES.refusedProduction;
}

export type RemakeResult =
  | { error: string; remakeId?: undefined; created?: undefined }
  | { error: null; remakeId: string; created: boolean };

/**
 * Create the remake. The RPC writes both audit rows in its own transaction;
 * do not add one here. 'duplicate' means a double click or retry found the
 * open remake, which is returned instead of a second one.
 */
export async function createRemake(
  client: SupabaseClient,
  actor: string,
  input: RemakeInput,
): Promise<RemakeResult> {
  const { data, error } = await client.rpc('create_order_remake', {
    p_order_id: input.orderId,
    p_reason: input.reason,
    p_note: input.note,
    p_legs: input.legs,
    p_actor: actor,
  });
  if (error) {
    if (error.code === 'P0002') {
      return { error: REMAKE_MESSAGES.orderNotFound };
    }
    if (error.code === '23514') {
      return { error: remakeRefusal(error.message) };
    }
    // 22023: input the form should have caught.
    if (error.code === '22023') {
      return { error: REMAKE_MESSAGES.refusedInput };
    }
    // The open-remake index caught a race the row lock did not.
    if (error.code === '23505') {
      return { error: REMAKE_MESSAGES.alreadyOpen };
    }
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    { remake_id?: unknown; outcome?: unknown } | null | undefined;
  if (!row || typeof row.remake_id !== 'string') {
    throw new Error('create_order_remake returned no row');
  }
  return { error: null, remakeId: row.remake_id, created: row.outcome === 'created' };
}
