import { describe, expect, it } from 'vitest';

import { validateMeasurements } from '@forms/shared';

import {
  listMeasurements,
  listOrders,
  listProducts,
  listScans,
  requestScanDeletion,
  toOrder,
  toProduct,
} from './api';
import { groupScanSessions, sessionStatus } from './library';

// No EXPO_PUBLIC_SUPABASE_* env vars are set in the test environment, so
// these stubs run in USE_FAKE_DATA mode: they must resolve with the demo rows
// rather than throw. This is the "zero backend configured" guarantee from
// CLAUDE.md / docs/DESIGN.md - the app (and its tests) must run clean with no
// Supabase project connected.
describe('data-layer stubs (no backend configured)', () => {
  it('listScans resolves to demo scans', async () => {
    const scans = await listScans();
    expect(scans.length).toBeGreaterThan(0);
    // Same values as the scans.leg CHECK constraint, so demo and real rows match.
    expect(scans.every((scan) => scan.leg === 'L' || scan.leg === 'R')).toBe(true);
  });

  it('demo scans cover every session status', async () => {
    const sessions = groupScanSessions(await listScans());
    expect(new Set(sessions.map(sessionStatus))).toEqual(
      new Set(['ready', 'processing', 'needs_rescan', 'one_leg']),
    );
  });

  it('demo measurements pass the frozen schema and only exist for measured legs', async () => {
    const scans = await listScans();
    const rows = await listMeasurements(scans.map((s) => s.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(validateMeasurements(row.values).valid).toBe(true);
      expect(scans.find((s) => s.id === row.scanId)?.status).toBe('ready');
    }
  });

  it('demo deletion removes both legs of a session from the library', async () => {
    const before = groupScanSessions(await listScans());
    const target = before.find((s) => sessionStatus(s) === 'needs_rescan');
    const ids = [target?.left?.id, target?.right?.id].filter((id): id is string => !!id);
    await requestScanDeletion(ids);
    const after = await listScans();
    expect(after.some((scan) => ids.includes(scan.id))).toBe(false);
    expect(groupScanSessions(after)).toHaveLength(before.length - 1);
  });

  it('listMeasurements returns nothing for no scan ids', async () => {
    expect(await listMeasurements([])).toEqual([]);
  });

  it('listOrders resolves to demo orders', async () => {
    const orders = await listOrders();
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((order) => (order.totalCents ?? 0) > 0)).toBe(true);
  });

  it('listProducts resolves to demo products', async () => {
    const products = await listProducts();
    expect(products.length).toBeGreaterThan(0);
    expect(products.every((product) => product.name && product.priceCents > 0)).toBe(true);
    expect(products.every((product) => product.image !== undefined)).toBe(true);
  });
});

// The admin panel (apps/web) writes these columns; these mappers are the
// app's half of that contract (supabase/migrations 0001 + 0009).
describe('row mappers', () => {
  it('maps an order row, taking name and currency from the product join', () => {
    expect(
      toOrder({
        id: 'o1',
        status: 'shipped',
        amount_cents: 8900,
        tracking_carrier: 'UPS',
        tracking_number: '1Z9',
        created_at: '2026-09-01T00:00:00Z',
        products: { name: 'Guard', currency: 'usd' },
      }),
    ).toEqual({
      id: 'o1',
      productName: 'Guard',
      status: 'shipped',
      totalCents: 8900,
      currency: 'usd',
      trackingCarrier: 'UPS',
      trackingNumber: '1Z9',
      createdAt: '2026-09-01T00:00:00Z',
    });
  });

  it('survives an order with no amount or product join', () => {
    const order = toOrder({
      id: 'o2',
      status: 'pending_payment',
      amount_cents: null,
      tracking_carrier: null,
      tracking_number: null,
      created_at: '2026-09-01T00:00:00Z',
      products: null,
    });
    expect(order.totalCents).toBeNull();
    expect(order.productName).toBe('Shin guard');
  });

  it('maps a product row and only adds an image when a URL is set', () => {
    const row = {
      id: 'p1',
      name: 'Guard',
      description: 'Fits.',
      base_price_cents: 8900,
      image_url: 'https://example.com/g.jpg',
    };
    expect(toProduct(row)).toEqual({
      id: 'p1',
      name: 'Guard',
      description: 'Fits.',
      priceCents: 8900,
      image: { uri: 'https://example.com/g.jpg' },
    });
    expect('image' in toProduct({ ...row, image_url: null })).toBe(false);
  });
});
