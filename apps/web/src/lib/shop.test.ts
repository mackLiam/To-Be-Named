import { ORDER_STATUSES } from '@forms/shared';
import { describe, expect, it } from 'vitest';

import {
  ORDER_STATUS_META,
  ORDER_TRANSITIONS,
  centsToPriceInput,
  describeAudit,
  formatAddress,
  checkOrderTransition,
  formatMoney,
  isUuid,
  nextOrderStatuses,
  parsePriceToCents,
  parseProductForm,
  parseTrackingForm,
} from './shop';

const validForm = {
  name: 'Custom Shin Guard',
  slug: 'custom-guard',
  description: 'Printed to your scan.',
  price: '89',
  currency: 'USD',
  image_url: '',
  active: 'on',
  cad_model: '',
};

describe('parsePriceToCents', () => {
  it.each([
    ['89', 8900],
    ['89.5', 8950],
    ['89.05', 8905],
    [' 0 ', 0],
  ])('%s -> %d', (raw, cents) => {
    expect(parsePriceToCents(raw)).toBe(cents);
  });

  it.each(['', '-1', '1.234', 'abc', '1,000', '1e3'])('rejects %j', (raw) => {
    expect(parsePriceToCents(raw)).toBeNull();
  });

  it('round-trips through the form input', () => {
    expect(parsePriceToCents(centsToPriceInput(16900))).toBe(16900);
  });
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
      },
    });
  });

  it('treats a missing active checkbox as inactive', () => {
    const result = parseProductForm({ ...validForm, active: undefined });
    expect(result.ok && result.value.active).toBe(false);
  });

  it('collects every field error at once', () => {
    const result = parseProductForm({
      name: '',
      slug: 'Bad Slug',
      price: 'free',
      currency: 'dollars',
      image_url: 'http://insecure.example/x.jpg',
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors).toHaveLength(5);
  });

  it('rejects a price above the typo guard', () => {
    expect(parseProductForm({ ...validForm, price: '1000.01' }).ok).toBe(false);
  });

  it('accepts a valid CAD descriptor', () => {
    const cad = { provider: 'dry_run', schema_version: '1.0.0', ref: {}, variable_map: null };
    const result = parseProductForm({ ...validForm, cad_model: JSON.stringify(cad) });
    expect(result.ok && result.value.cad_model).toEqual(cad);
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
    expect(describeAudit({ action: 'order.refund', detail: null })).toBe('order.refund');
  });
});
