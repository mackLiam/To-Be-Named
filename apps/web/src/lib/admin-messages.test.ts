import { describe, expect, it } from 'vitest';

import {
  ADMIN_ERRORS,
  ADMIN_NOTICES,
  adminErrorText,
  adminNoticeText,
  errorCode,
  flashPath,
  noticeCode,
} from './admin-messages';
import { ALREADY_ACTIVE, NOT_RETRIABLE } from './ops';
import { ORDER_NOTICES, READ_ONLY } from './order-actions';
import { parseNoteForm } from './order-notes';
import { parseAltText } from './product-images';
import { REFUND_MESSAGES } from './refund';
import { REMAKE_MESSAGES, parseRemakeForm } from './remake';
import { checkOrderTransition, parseTrackingForm } from './shop';

const ORDER = '00000000-0000-4000-8000-0000000000a1';
const REQ = '00000000-0000-4000-8000-0000000000f1';

function firstError(result: { ok: boolean; errors?: string[] }): string {
  if (result.ok || !result.errors) {
    throw new Error('expected a parse error');
  }
  return result.errors[0]!;
}

describe('code to text', () => {
  it('maps every known code to its fixed text', () => {
    for (const [code, text] of Object.entries(ADMIN_ERRORS)) {
      expect(adminErrorText(code)).toBe(text);
    }
    for (const [code, text] of Object.entries(ADMIN_NOTICES)) {
      expect(adminNoticeText(code)).toBe(text);
    }
    expect(adminErrorText('order_not_found')).toBe('Order not found.');
    expect(adminNoticeText('refund_issued')).toBe('Refund issued.');
  });

  it.each([
    [undefined],
    [null],
    [''],
    ['nope'],
    ['Order not found.'],
    ['Call +1 555 0100 to confirm your refund'],
    ['constructor'],
    ['__proto__'],
    ['toString'],
    ['hasOwnProperty'],
    ['ORDER_NOT_FOUND'],
  ])('renders nothing for the unknown code %o', (code) => {
    expect(adminErrorText(code)).toBeNull();
    expect(adminNoticeText(code)).toBeNull();
  });

  it('keeps errors and notices apart', () => {
    expect(adminErrorText('refund_issued')).toBeNull();
    expect(adminNoticeText('order_not_found')).toBeNull();
  });

  it('uses url-safe codes, unique texts, and no em or en dashes', () => {
    const all = { ...ADMIN_ERRORS, ...ADMIN_NOTICES };
    for (const [code, text] of Object.entries(all)) {
      expect(code).toMatch(/^[a-z_]+$/);
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
    const texts = Object.values(all);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('text to code', () => {
  it('maps every exact lib message to its own code, not the fallback', () => {
    const libMessages = [
      READ_ONLY,
      NOT_RETRIABLE,
      ALREADY_ACTIVE,
      ...Object.values(REFUND_MESSAGES),
      ...Object.values(REMAKE_MESSAGES),
      firstError(parseRemakeForm({ id: ORDER })),
      firstError(parseRemakeForm({ id: ORDER, reason: 'print_defect', legs: 'middle' })),
      firstError(parseRemakeForm({ id: ORDER, reason: 'other' })),
      firstError(parseRemakeForm({ id: ORDER, reason: 'print_defect', note: 'x'.repeat(501) })),
      firstError(parseNoteForm({ id: ORDER, body: '', request_id: REQ })),
      firstError(parseNoteForm({ id: ORDER, body: 'x', request_id: 'nope' })),
      firstError(parseNoteForm({ id: ORDER, body: 'x'.repeat(2001), request_id: REQ })),
      firstError(parseTrackingForm({ tracking_carrier: 'x'.repeat(41) })),
      firstError(parseTrackingForm({ tracking_number: '!' })),
      firstError(parseAltText('')),
      firstError(parseAltText('a'.repeat(201))),
      checkOrderTransition('in_production', 'shipped', { trackingNumber: null })!,
    ];
    for (const text of libMessages) {
      const code = errorCode(text, 'action_failed');
      expect(code, text).not.toBe('action_failed');
      expect(adminErrorText(code)).toBe(text);
    }
  });

  it('maps any other text to the fallback, and no error to null', () => {
    expect(errorCode('permission denied for table orders', 'refund_failed')).toBe('refund_failed');
    expect(errorCode('Unknown order. Choose a reason for the remake.', 'remake_form_invalid')).toBe(
      'remake_form_invalid',
    );
    expect(errorCode(null, 'action_failed')).toBeNull();
    expect(errorCode('', 'action_failed')).toBeNull();
  });

  it('maps known notices and drops any other text', () => {
    for (const [code, text] of Object.entries(ADMIN_NOTICES)) {
      expect(noticeCode(text)).toBe(code);
    }
    for (const text of Object.values(ORDER_NOTICES)) {
      expect(noticeCode(text)).not.toBeNull();
    }
    expect(noticeCode('Something else happened.')).toBeNull();
    expect(noticeCode(null)).toBeNull();
  });
});

describe('flashPath', () => {
  const path = `/admin/orders/${ORDER}`;

  it('carries only the code, error before notice', () => {
    expect(flashPath(path, { error: 'order_not_found', notice: 'refund_issued' })).toBe(
      `${path}?error=order_not_found`,
    );
    expect(flashPath(path, { error: null, notice: 'refund_issued' })).toBe(
      `${path}?notice=refund_issued`,
    );
    expect(flashPath(path, {})).toBe(path);
  });

  it('appends a fixed anchor after the query', () => {
    expect(flashPath('/admin/products/x', { error: 'unknown_photo' }, '#photos')).toBe(
      '/admin/products/x?error=unknown_photo#photos',
    );
    expect(flashPath('/admin/products/x', {}, '#photos')).toBe('/admin/products/x#photos');
  });
});
