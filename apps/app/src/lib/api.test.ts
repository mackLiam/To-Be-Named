import { describe, expect, it } from 'vitest';

import { listOrders, listProducts, listScans } from './api';

// No EXPO_PUBLIC_SUPABASE_* env vars are set in the test environment, so
// these stubs run in USE_FAKE_DATA mode: they must resolve with the demo rows
// rather than throw. This is the "zero backend configured" guarantee from
// CLAUDE.md / docs/DESIGN.md - the app (and its tests) must run clean with no
// Supabase project connected.
describe('data-layer stubs (no backend configured)', () => {
  it('listScans resolves to demo scans', async () => {
    const scans = await listScans();
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every((scan) => scan.leg === 'left' || scan.leg === 'right')).toBe(true);
  });

  it('listOrders resolves to demo orders', async () => {
    const orders = await listOrders();
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((order) => order.totalCents > 0)).toBe(true);
  });

  it('listProducts resolves to demo products', async () => {
    const products = await listProducts();
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((product) => product.name && product.priceCents > 0)).toBe(true);
  });
});
