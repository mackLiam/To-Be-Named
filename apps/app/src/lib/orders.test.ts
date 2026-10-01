import { describe, expect, it } from 'vitest';

import { orderReference, trackingUrl } from './orders';

describe('orderReference', () => {
  it('is the first 8 characters, upper case', () => {
    expect(orderReference('abcdef12-0000-4000-8000-000000000001')).toBe('ABCDEF12');
  });
});

describe('trackingUrl', () => {
  it('links known carriers whatever the admin typed', () => {
    expect(trackingUrl('UPS', '1Z999AA10123456784')).toBe(
      'https://www.ups.com/track?tracknum=1Z999AA10123456784',
    );
    expect(trackingUrl(' Fed Ex ', '123')).toBe('https://www.fedex.com/fedextrack/?trknbr=123');
    expect(trackingUrl('U.S.P.S', '9400')).toContain('tLabels=9400');
  });

  it('encodes the number so it cannot change the URL', () => {
    expect(trackingUrl('ups', '1Z 9&x=1')).toBe(
      'https://www.ups.com/track?tracknum=1Z%209%26x%3D1',
    );
  });

  it('is null for an unknown carrier or a missing number', () => {
    expect(trackingUrl('Royal Mail', '123')).toBeNull();
    expect(trackingUrl(null, '123')).toBeNull();
    expect(trackingUrl('ups', null)).toBeNull();
  });
});
