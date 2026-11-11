import { ALREADY_ACTIVE, NOT_RETRIABLE } from './ops';
import { ORDER_NOTICES, READ_ONLY } from './order-actions';
import { MAX_NOTE_LENGTH } from './order-notes';
import { MAX_ALT_TEXT } from './product-images';
import { REFUND_MESSAGES } from './refund';
import { MAX_REMAKE_NOTE, REMAKE_MESSAGES } from './remake';

/**
 * Admin flash messages after a redirect. The URL carries only a code
 * (?error=<code> or ?notice=<code>); a page renders the fixed text for a
 * known code and nothing for anything else, so a crafted link cannot put its
 * own words on an admin page.
 *
 * Actions turn a lib message into a code with errorCode or noticeCode: an
 * exact catalog text maps to its code, and any other text (a database
 * message, joined form errors) maps to the caller's fallback.
 */

export const ADMIN_ERRORS = {
  read_only: READ_ONLY,
  action_failed: 'The change was not saved. Reload the page and try again.',

  unknown_order: 'Unknown order.',
  order_not_found: 'Order not found.',
  order_changed: 'The order changed while you were looking at it. Reload and try again.',
  tracking_needed: 'Add a tracking number before marking the order shipped.',
  status_refused:
    'That status move was refused: it is not allowed from the current status, or the product has no CAD model or a scan has no measurements.',
  carrier_too_long: 'Carrier must be at most 40 characters.',
  tracking_number_invalid: 'Tracking number must be 4 to 40 letters, digits, spaces or hyphens.',
  tracking_invalid:
    'Check the tracking details: carrier at most 40 characters, number 4 to 40 letters, digits, spaces or hyphens.',

  remake_reason_needed: 'Choose a reason for the remake.',
  remake_legs_needed: 'Choose which legs to remake.',
  remake_note_too_long: `The note must be at most ${MAX_REMAKE_NOTE} characters.`,
  remake_other_needs_note: 'Describe the reason when it is Other.',
  remake_form_invalid:
    'Check the remake form: choose a reason and legs, describe Other, and keep the note short.',
  remake_refused_status: REMAKE_MESSAGES.refusedStatus,
  remake_refused_deleted: REMAKE_MESSAGES.refusedDeleted,
  remake_refused_deleting: REMAKE_MESSAGES.refusedDeleting,
  remake_refused_production: REMAKE_MESSAGES.refusedProduction,
  remake_refused_input: REMAKE_MESSAGES.refusedInput,
  remake_already_open: REMAKE_MESSAGES.alreadyOpen,

  refund_mode_needed: 'Choose a full or a partial refund.',
  refund_amount_needed: 'Enter the refund amount, for example 12.50.',
  refunds_unavailable: 'Refunds are unavailable: STRIPE_SECRET_KEY is not configured.',
  refund_not_refundable: REFUND_MESSAGES.notRefundable,
  refund_nothing_left: REFUND_MESSAGES.nothingLeft,
  refund_bad_amount: REFUND_MESSAGES.badAmount,
  refund_too_many: REFUND_MESSAGES.tooMany,
  refund_list_failed: REFUND_MESSAGES.listFailed,
  refund_reconciled: REFUND_MESSAGES.reconciled,
  refund_reconcile_failed: REFUND_MESSAGES.reconcileFailed,
  refund_stripe_failed: REFUND_MESSAGES.stripeFailed,
  refund_not_recorded: REFUND_MESSAGES.notRecorded,
  refund_not_cancelled: REFUND_MESSAGES.notCancelled,
  refund_failed: 'The refund did not go through. Check the Stripe dashboard before trying again.',

  note_expired: 'The note form expired. Reload the page and try again.',
  note_empty: 'Write the note before saving it.',
  note_too_long: `A note is at most ${MAX_NOTE_LENGTH} characters.`,
  note_failed: 'The note was not saved. Reload the page and try again.',

  unknown_product: 'Unknown product.',
  unknown_product_or_direction: 'Unknown product or direction.',
  product_not_found: 'Product not found.',

  unknown_photo: 'Unknown photo.',
  unknown_direction: 'Unknown direction.',
  photo_not_found: 'Photo not found.',
  photo_main_conflict: 'Another change set the main photo at the same time. Reload and try again.',
  alt_required: 'Alt text is required: describe what the photo shows.',
  alt_too_long: `Alt text must be at most ${MAX_ALT_TEXT} characters.`,

  invalid_job_id: 'Invalid job id.',
  job_not_retriable: NOT_RETRIABLE,
  job_already_active: ALREADY_ACTIVE,
} as const;

export const ADMIN_NOTICES = {
  remake_created: ORDER_NOTICES.remakeCreated,
  remake_existing: ORDER_NOTICES.remakeExisting,
  refund_issued: ORDER_NOTICES.refundIssued,
  refund_repeat: ORDER_NOTICES.refundRepeat,
  note_added: ORDER_NOTICES.noteAdded,
} as const;

export type AdminErrorCode = keyof typeof ADMIN_ERRORS;
export type AdminNoticeCode = keyof typeof ADMIN_NOTICES;

function textFor<T extends Record<string, string>>(
  catalog: T,
  code: string | null | undefined,
): string | null {
  // Own keys only: 'constructor' or '__proto__' must not resolve to anything.
  return code && Object.prototype.hasOwnProperty.call(catalog, code)
    ? catalog[code as keyof T]!
    : null;
}

/** The fixed text for an ?error= code; null for a missing or unknown code. */
export function adminErrorText(code: string | null | undefined): string | null {
  return textFor(ADMIN_ERRORS, code);
}

/** The fixed text for a ?notice= code; null for a missing or unknown code. */
export function adminNoticeText(code: string | null | undefined): string | null {
  return textFor(ADMIN_NOTICES, code);
}

function reverse<K extends string>(catalog: Record<K, string>): Map<string, K> {
  const out = new Map<string, K>();
  for (const [code, text] of Object.entries(catalog) as [K, string][]) {
    out.set(text, code);
  }
  return out;
}

const ERROR_BY_TEXT = reverse(ADMIN_ERRORS);
const NOTICE_BY_TEXT = reverse(ADMIN_NOTICES);

/** The code for a lib error message; null when there is no error. */
export function errorCode(
  text: string | null | undefined,
  fallback: AdminErrorCode,
): AdminErrorCode | null {
  if (!text) {
    return null;
  }
  return ERROR_BY_TEXT.get(text) ?? fallback;
}

/** The code for a lib notice; null for none or any text outside the catalog. */
export function noticeCode(text: string | null | undefined): AdminNoticeCode | null {
  return text ? (NOTICE_BY_TEXT.get(text) ?? null) : null;
}

/**
 * The redirect target for an action outcome: an error wins over a notice.
 * `hash` is a fixed in-page anchor such as '#photos'.
 */
export function flashPath(
  path: string,
  flash: { error?: AdminErrorCode | null; notice?: AdminNoticeCode | null },
  hash = '',
): string {
  if (flash.error) {
    return `${path}?error=${flash.error}${hash}`;
  }
  if (flash.notice) {
    return `${path}?notice=${flash.notice}${hash}`;
  }
  return `${path}${hash}`;
}
