import { ORDER_STATUSES } from '@forms/shared';
import { describe, expect, it } from 'vitest';

import {
  ORDER_STATUS_META,
  ORDER_TRANSITIONS,
  customerLabel,
  describeAudit,
  formatAddress,
  checkOrderTransition,
  formatMoney,
  isUuid,
  nextOrderStatuses,
  orderReferenceRange,
  parseCents,
  parseProductForm,
  parseTrackingForm,
} from './shop';

const validForm = {
  name: 'Custom Shin Guard',
  slug: 'custom-guard',
  description: 'Printed to your scan.',
  base_price_cents: '8900',
  currency: 'USD',
  image_url: '',
  active: 'on',
  cad_model: '',
  display_order: '3',
  availability: 'coming_soon',
};

const CAD = {
  provider: 'dry_run',
  schema_version: '1.1.0',
  profile: { kind: 'identity' },
  ref: {},
  variable_map: null,
};

describe('parseCents', () => {
  it.each([
    ['8900', 8900],
    [' 0 ', 0],
    ['100000', 100000],
  ])('%s -> %d', (raw, cents) => {
    expect(parseCents(raw)).toBe(cents);
  });

  it.each(['', '-1', '89.00', 'abc', '1,000', '1e3', '+5', '1234567890', undefined])(
    'rejects %j',
    (raw) => {
      expect(parseCents(raw)).toBeNull();
    },
  );
});

describe('parseProductForm', () => {
  it('accepts a valid form and normalizes it', () => {
    const result = parseProductForm(validForm);
    expect(result).toEqual({
      ok: true,
      value: {
        name: 'Custom Shin Guard',
        slug: 'custom-guard',
        description: 'Printed to your scan.',
        base_price_cents: 8900,
        currency: 'usd',
        image_url: null,
        active: true,
        cad_model: null,
        display_order: 3,
        availability: 'coming_soon',
        sizing_modes: ['custom'],
      },
    });
  });

  it('treats a missing active checkbox as inactive', () => {
    const result = parseProductForm({ ...validForm, active: undefined });
    expect(result.ok && result.value.active).toBe(false);
  });

  it('collects every field error at once', () => {
    const result = parseProductForm(
      {
        name: '',
        slug: 'Bad Slug',
        base_price_cents: '89.00',
        currency: 'dollars',
        image_url: 'http://insecure.example/x.jpg',
        display_order: '-1',
        availability: 'sold_out',
      },
      [],
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toHaveLength(8);
  });

  it('rejects a price above the typo guard', () => {
    expect(parseProductForm({ ...validForm, base_price_cents: '100001' }).ok).toBe(false);
  });

  it('defaults an empty display order to 0 and caps it', () => {
    const empty = parseProductForm({ ...validForm, display_order: '' });
    expect(empty.ok && empty.value.display_order).toBe(0);
    expect(parseProductForm({ ...validForm, display_order: '100001' }).ok).toBe(false);
    expect(parseProductForm({ ...validForm, display_order: '1.5' }).ok).toBe(false);
  });

  it('accepts each availability state', () => {
    for (const availability of ['coming_soon', 'paused']) {
      const result = parseProductForm({ ...validForm, availability });
      expect(result.ok && result.value.availability).toBe(availability);
    }
    const missing = parseProductForm({ ...validForm, availability: undefined });
    expect(missing.ok).toBe(false);
  });

  it('normalizes sizing modes and rejects unknown or empty sets', () => {
    const ok = parseProductForm(validForm, ['preset_l', 'custom', 'custom']);
    expect(ok.ok && ok.value.sizing_modes).toEqual(['custom', 'preset_l']);
    expect(parseProductForm(validForm, []).ok).toBe(false);
    expect(parseProductForm(validForm, ['custom', 'preset_xl']).ok).toBe(false);
  });

  it('refuses available without a CAD model or with a zero price', () => {
    const noCad = parseProductForm({ ...validForm, availability: 'available' });
    expect(!noCad.ok && noCad.errors).toEqual([
      'Add a CAD model descriptor before making the product available.',
    ]);
    const free = parseProductForm({
      ...validForm,
      availability: 'available',
      cad_model: JSON.stringify(CAD),
      base_price_cents: '0',
    });
    expect(!free.ok && free.errors).toEqual(['A product must cost more than 0 to be available.']);
    const good = parseProductForm({
      ...validForm,
      availability: 'available',
      cad_model: JSON.stringify(CAD),
    });
    expect(good.ok && good.value.availability).toBe('available');
  });

  it('allows a zero price while not purchasable', () => {
    expect(parseProductForm({ ...validForm, base_price_cents: '0' }).ok).toBe(true);
  });

  it('accepts a valid CAD descriptor', () => {
    const result = parseProductForm({ ...validForm, cad_model: JSON.stringify(CAD) });
    expect(result.ok && result.value.cad_model).toEqual(CAD);
  });

  it('rejects malformed JSON and invalid descriptors', () => {
    expect(parseProductForm({ ...validForm, cad_model: '{nope' }).ok).toBe(false);
    const bad = parseProductForm({ ...validForm, cad_model: '{"provider":"solidworks"}' });
    expect(!bad.ok && bad.errors.every((e) => e.startsWith('CAD model'))).toBe(true);
  });
});

describe('order transitions', () => {
  it('covers every shared order status', () => {
    expect(Object.keys(ORDER_TRANSITIONS).sort()).toEqual([...ORDER_STATUSES].sort());
    expect(Object.keys(ORDER_STATUS_META).sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('only targets real statuses', () => {
    for (const targets of Object.values(ORDER_TRANSITIONS)) {
      for (const to of targets) {
        expect(ORDER_STATUSES).toContain(to);
      }
    }
  });

  it('treats delivered and cancelled as terminal', () => {
    expect(nextOrderStatuses('delivered')).toEqual([]);
    expect(nextOrderStatuses('cancelled')).toEqual([]);
    expect(nextOrderStatuses('not-a-status')).toEqual([]);
  });

  it('allows the happy path', () => {
    expect(checkOrderTransition('pending_payment', 'paid', { trackingNumber: null })).toBeNull();
    expect(checkOrderTransition('paid', 'in_production', { trackingNumber: null })).toBeNull();
    expect(
      checkOrderTransition('in_production', 'shipped', { trackingNumber: '1Z999' }),
    ).toBeNull();
    expect(checkOrderTransition('shipped', 'delivered', { trackingNumber: '1Z999' })).toBeNull();
  });

  it('refuses to ship without tracking', () => {
    expect(checkOrderTransition('in_production', 'shipped', { trackingNumber: '  ' })).toMatch(
      /tracking number/,
    );
  });

  it('refuses skips, reversals, and unknown targets', () => {
    expect(checkOrderTransition('paid', 'delivered', { trackingNumber: 'x' })).not.toBeNull();
    expect(checkOrderTransition('shipped', 'cancelled', { trackingNumber: 'x' })).not.toBeNull();
    expect(checkOrderTransition('cancelled', 'paid', { trackingNumber: null })).not.toBeNull();
    expect(checkOrderTransition('paid', 'refunded', { trackingNumber: null })).toMatch(/Unknown/);
  });
});

describe('parseTrackingForm', () => {
  it('trims and nulls empty values', () => {
    expect(parseTrackingForm({ tracking_carrier: ' UPS ', tracking_number: '' })).toEqual({
      ok: true,
      value: { tracking_carrier: 'UPS', tracking_number: null },
    });
  });

  it('rejects junk tracking numbers', () => {
    expect(parseTrackingForm({ tracking_number: '<script>' }).ok).toBe(false);
    expect(parseTrackingForm({ tracking_number: 'ab' }).ok).toBe(false);
  });
});

describe('formatMoney', () => {
  it('formats cents with the currency', () => {
    expect(formatMoney(8900, 'usd')).toBe('$89.00');
    expect(formatMoney(null, 'usd')).toBe('-');
  });
});

describe('isUuid', () => {
  it('accepts uuids and rejects anything else', () => {
    expect(isUuid('00000000-0000-4000-8000-0000000000a1')).toBe(true);
    expect(isUuid('new')).toBe(false);
    expect(isUuid("1' or 1=1")).toBe(false);
  });
});

describe('formatAddress', () => {
  it('orders known string fields and drops the rest', () => {
    expect(
      formatAddress({
        country: 'US',
        line1: '1 Main St ',
        name: 'Sam',
        line2: '',
        zip: 1,
        city: 7,
      }),
    ).toBe('Sam\n1 Main St\nUS');
    expect(formatAddress(null)).toBe('');
  });
});

describe('describeAudit', () => {
  it('describes status moves and tracking changes', () => {
    expect(
      describeAudit({ action: 'order.status', detail: { from: 'paid', to: 'in_production' } }),
    ).toBe('Paid to In production');
    expect(
      describeAudit({
        action: 'order.tracking',
        detail: { tracking_carrier: 'UPS', tracking_number: '1Z9' },
      }),
    ).toBe('Tracking set to UPS 1Z9');
    expect(describeAudit({ action: 'order.tracking', detail: { tracking_number: null } })).toBe(
      'Tracking cleared',
    );
    expect(describeAudit({ action: 'order.note', detail: null })).toBe('order.note');
  });
});

describe('orderReferenceRange', () => {
  it('maps the 8-character reference to the id range it prefixes', () => {
    expect(orderReferenceRange(' #ABCDEF12 ')).toEqual({
      from: 'abcdef12-0000-0000-0000-000000000000',
      to: 'abcdef12-ffff-ffff-ffff-ffffffffffff',
    });
  });

  it('rejects anything that is not exactly 8 hex characters', () => {
    for (const bad of [undefined, '', 'abcdef1', 'abcdef123', 'abcdefgh', "abcdef1'"]) {
      expect(orderReferenceRange(bad)).toBeNull();
    }
  });
});

describe('describeAudit refunds', () => {
  it('labels a refund row', () => {
    expect(describeAudit({ action: 'order.refund', detail: { refund_status: 'succeeded' } })).toBe(
      'Refund issued (succeeded)',
    );
  });
});

describe('customerLabel', () => {
  it('prefers the email, then the short user id', () => {
    expect(customerLabel({ customer_email: 'a@b.co', user_id: 'abcdef12-0000' })).toBe('a@b.co');
    expect(customerLabel({ customer_email: null, user_id: 'abcdef12-0000' })).toBe('abcdef12');
  });

  it('names a deleted account instead of crashing on a null user', () => {
    expect(customerLabel({ customer_email: null, user_id: null })).toBe('Deleted account');
  });
});
