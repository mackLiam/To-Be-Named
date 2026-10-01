import { describe, expect, it } from 'vitest';

import { validateMeasurements } from '@forms/shared';

import { listMeasurements, listOrders, listProducts, listScans } from './api';
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

  it('demo scans form left + right sessions covering ready, processing and rescan', async () => {
    const sessions = groupScanSessions(await listScans());
    expect(sessions.every((s) => s.left && s.right)).toBe(true);
    expect(new Set(sessions.map(sessionStatus))).toEqual(
      new Set(['ready', 'processing', 'needs_rescan']),
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

  it('listMeasurements returns nothing for no scan ids', async () => {
    expect(await listMeasurements([])).toEqual([]);
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
    expect(products.every((product) => product.image !== undefined)).toBe(true);
  });
});
