import { describe, expect, it } from 'vitest';

import { ADMIN_NAV, activeAdminNav } from './admin-nav';

describe('activeAdminNav', () => {
  it('matches each section and its detail pages', () => {
    expect(activeAdminNav('/admin/orders')).toBe('/admin/orders');
    expect(activeAdminNav('/admin/orders/9f1c2d3e-0000-4000-8000-000000000000')).toBe(
      '/admin/orders',
    );
    expect(activeAdminNav('/admin/products/new')).toBe('/admin/products');
    expect(activeAdminNav('/admin/print-queue')).toBe('/admin/print-queue');
    expect(activeAdminNav('/admin/orders/9f1c2d3e-0000-4000-8000-000000000000/packing-slip')).toBe(
      '/admin/orders',
    );
    expect(activeAdminNav('/admin/customers')).toBe('/admin/customers');
    expect(activeAdminNav('/admin/waitlist')).toBe('/admin/waitlist');
    expect(activeAdminNav('/admin/audit/')).toBe('/admin/audit');
  });

  it('puts the queue and job detail under the pipeline queue', () => {
    expect(activeAdminNav('/admin')).toBe('/admin');
    expect(activeAdminNav('/admin/')).toBe('/admin');
    expect(activeAdminNav('/admin/jobs/abc')).toBe('/admin');
  });

  it('does not match look-alike prefixes or other paths', () => {
    expect(activeAdminNav('/admin/ordersx')).toBeNull();
    expect(activeAdminNav('/login')).toBeNull();
    expect(activeAdminNav(null)).toBeNull();
  });

  it('lists every section once', () => {
    const hrefs = ADMIN_NAV.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});
