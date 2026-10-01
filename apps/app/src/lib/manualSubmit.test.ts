import { MEASUREMENT_KEYS } from '@forms/shared';
import { describe, expect, it } from 'vitest';

import { SLICES, sliceKey } from './library';
import { deriveMeasurements, type Values } from './manualMeasurements';
import {
  MANUAL_SUBMIT_MESSAGES,
  ManualSubmitError,
  NEW_SCAN_ID,
  manualSubmitMessage,
  resultRouteKey,
  submitManual,
  submitManualWith,
  type ManualSubmitDeps,
} from './manualSubmit';

// No EXPO_PUBLIC_SUPABASE_* in the test env, so submitManual runs fake mode.

function values(): Values {
  const v: Values = { Leg_Length: 392 };
  SLICES.forEach((slice, i) => {
    v[sliceKey(slice, 'OW')] = 61 + i * 14;
    v[sliceKey(slice, 'OD')] = 70 + i * 15;
  });
  return deriveMeasurements(v).values;
}

interface Result {
  data: unknown;
  error: { message: string; code?: string } | null;
}

function harness(opts: { upsert?: Result; rpc?: Result; userId?: () => Promise<string> } = {}) {
  const order: string[] = [];
  const upserts: { table: string; row: Record<string, unknown>; options: unknown }[] = [];
  const rpcs: { name: string; params: Record<string, unknown> }[] = [];
  const client = {
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>, options: unknown) => {
        upserts.push({ table, row, options });
        return {
          select: () => ({
            single: async () => {
              order.push('upsert');
              return opts.upsert ?? { data: { id: 'x' }, error: null };
            },
          }),
        };
      },
    }),
    rpc: async (name: string, params: Record<string, unknown>) => {
      order.push('rpc');
      rpcs.push({ name, params });
      return opts.rpc ?? { data: 'measurement-1', error: null };
    },
  };
  const deps = {
    client,
    getUserId: opts.userId ?? (async () => 'user-1'),
    newScanId: () => 'generated-id',
  } as unknown as ManualSubmitDeps;
  return { deps, order, upserts, rpcs };
}

describe('submitManualWith', () => {
  it('creates the manual scan row, then calls the RPC with all 25 values', async () => {
    const h = harness();
    const result = await submitManualWith(h.deps, {
      scanId: NEW_SCAN_ID,
      leg: 'L',
      pairId: 'pair-1',
      newScanId: 'scan-9',
      values: values(),
    });
    expect(h.order).toEqual(['upsert', 'rpc']);
    expect(h.upserts[0]).toEqual({
      table: 'scans',
      row: {
        id: 'scan-9',
        user_id: 'user-1',
        leg: 'L',
        status: 'uploaded',
        capture_kind: 'manual',
        mesh_path: null,
        pair_id: 'pair-1',
      },
      options: { onConflict: 'id' },
    });
    expect(h.rpcs[0]?.name).toBe('submit_manual_measurements');
    expect(h.rpcs[0]?.params.p_scan_id).toBe('scan-9');
    expect(Object.keys(h.rpcs[0]?.params.p_values as object)).toEqual([...MEASUREMENT_KEYS]);
    expect(result).toEqual({ scanId: 'scan-9', measurementId: 'measurement-1', fake: false });
  });

  it('generates an id when none is passed', async () => {
    const h = harness();
    const result = await submitManualWith(h.deps, {
      scanId: NEW_SCAN_ID,
      leg: 'R',
      values: values(),
    });
    expect(result.scanId).toBe('generated-id');
    expect(h.upserts[0]?.row.pair_id).toBeNull();
  });

  it('skips the insert for an existing scan', async () => {
    const h = harness();
    await submitManualWith(h.deps, { scanId: 'scan-1', values: values() });
    expect(h.order).toEqual(['rpc']);
    expect(h.rpcs[0]?.params.p_scan_id).toBe('scan-1');
  });

  it('refuses invalid values before any network call', async () => {
    const h = harness();
    const bad = { ...values(), S2_OD: 999 };
    await expect(submitManualWith(h.deps, { scanId: 'scan-1', values: bad })).rejects.toMatchObject(
      { code: 'ERR_MANUAL_INVALID' },
    );
    expect(h.order).toEqual([]);
  });

  it('needs a leg for a new scan', async () => {
    const h = harness();
    await expect(
      submitManualWith(h.deps, { scanId: NEW_SCAN_ID, leg: null, values: values() }),
    ).rejects.toMatchObject({ code: 'ERR_MANUAL_NO_LEG' });
    expect(h.order).toEqual([]);
  });

  it('maps a missing session', async () => {
    const h = harness({ userId: async () => Promise.reject(new Error('no user')) });
    await expect(
      submitManualWith(h.deps, { scanId: NEW_SCAN_ID, leg: 'L', values: values() }),
    ).rejects.toMatchObject({ code: 'ERR_MANUAL_NO_SESSION' });
  });

  it('stops when the scan row fails', async () => {
    const h = harness({ upsert: { data: null, error: { message: 'rls' } } });
    await expect(
      submitManualWith(h.deps, { scanId: NEW_SCAN_ID, leg: 'L', values: values() }),
    ).rejects.toMatchObject({ code: 'ERR_MANUAL_SCAN_DB' });
    expect(h.order).toEqual(['upsert']);
  });

  it('maps 55P03 to measurement in progress, anything else to a generic failure', async () => {
    const busy = harness({ rpc: { data: null, error: { message: 'lock', code: '55P03' } } });
    const error = await submitManualWith(busy.deps, { scanId: 's', values: values() }).catch(
      (e: unknown) => e,
    );
    expect(manualSubmitMessage(error)).toBe('A measurement is already in progress for this scan.');

    const other = harness({ rpc: { data: null, error: { message: 'x', code: '22023' } } });
    await expect(
      submitManualWith(other.deps, { scanId: 's', values: values() }),
    ).rejects.toMatchObject({ code: 'ERR_MANUAL_RPC' });
  });
});

describe('helpers', () => {
  it('routes to the pair when present, else the scan', () => {
    expect(resultRouteKey({ pairId: 'pair-1' }, 'scan-1')).toBe('pair-1');
    expect(resultRouteKey({ pairId: null }, 'scan-1')).toBe('scan-1');
  });

  it('gives a generic message for unknown errors', () => {
    expect(manualSubmitMessage(new Error('boom'))).toBe(MANUAL_SUBMIT_MESSAGES.ERR_MANUAL_RPC);
    expect(new ManualSubmitError('ERR_MANUAL_INVALID')).toBeInstanceOf(ManualSubmitError);
  });
});

describe('submitManual (fake mode)', () => {
  it('simulates success and keeps the passed id', async () => {
    await expect(
      submitManual({ scanId: NEW_SCAN_ID, leg: 'L', newScanId: 'scan-7', values: values() }),
    ).resolves.toEqual({ scanId: 'scan-7', measurementId: null, fake: true });
    await expect(submitManual({ scanId: 'scan-1', values: values() })).resolves.toMatchObject({
      scanId: 'scan-1',
      fake: true,
    });
  });

  it('still refuses invalid values', async () => {
    await expect(submitManual({ scanId: 'scan-1', values: {} })).rejects.toMatchObject({
      code: 'ERR_MANUAL_INVALID',
    });
  });
});
