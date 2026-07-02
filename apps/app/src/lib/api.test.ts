import { describe, expect, it } from 'vitest';

import { listOrders, listProducts, listScans } from './api';

// No EXPO_PUBLIC_SUPABASE_* env vars are set in the test environment, so
// these stubs run in USE_FAKE_DATA mode: they must resolve, not throw, and
// return typed empty arrays. This is the "zero backend configured" guarantee
// from CLAUDE.md / docs/DESIGN.md - the app (and its tests) must run clean
// with no Supabase project connected.
describe('data-layer stubs (no backend configured)', () => {
  it('listScans resolves to an empty array', async () => {
    await expect(listScans()).resolves.toEqual([]);
  });

  it('listOrders resolves to an empty array', async () => {
    await expect(listOrders()).resolves.toEqual([]);
  });

  it('listProducts resolves to an empty array', async () => {
    await expect(listProducts()).resolves.toEqual([]);
  });
});
