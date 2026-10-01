import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FAKE_ATTENTION_COUNTS, buildAttentionItems, getAttentionCounts } from './attention';
import { applyNeedsRefund } from './data';

type Call = [string, ...unknown[]];

// Records every builder call; awaiting it resolves to the configured result.
function fakeBuilder(calls: Call[], result: { count: number | null; error: unknown }) {
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'not', 'is']) {
    b[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => resolve(result);
  return b;
}

describe('applyNeedsRefund', () => {
  it('filters cancelled, payment present, not refunded', () => {
    const calls: Call[] = [];
    const b = fakeBuilder(calls, { count: 0, error: null }) as never;
    applyNeedsRefund(b);
    expect(calls).toEqual([
      ['eq', 'status', 'cancelled'],
      ['not', 'stripe_payment_intent', 'is', null],
      ['is', 'refunded_at', null],
    ]);
  });
});

describe('buildAttentionItems', () => {
  it('drops zero counts and links each item', () => {
    const items = buildAttentionItems({ paid_not_started: 0, dead_letter: 3, needs_refund: 1 });
    expect(items.map((i) => [i.key, i.count, i.href])).toEqual([
      ['dead_letter', 3, '/admin?status=dead_letter'],
      ['needs_refund', 1, '/admin/orders?needs_refund=1'],
    ]);
  });

  it('returns nothing when every count is zero', () => {
    expect(buildAttentionItems({ paid_not_started: 0, dead_letter: 0, needs_refund: 0 })).toEqual(
      [],
    );
  });
});

describe('getAttentionCounts', () => {
  const ENV = [
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.doUnmock('./supabase-admin');
    vi.resetModules();
  });

  it('returns fixed counts in fake mode', async () => {
    for (const k of ENV) delete process.env[k];
    expect(await getAttentionCounts()).toEqual(FAKE_ATTENTION_COUNTS);
  });

  async function live(result: { count: number | null; error: unknown }) {
    for (const k of ENV) process.env[k] = 'x';
    const calls: Call[] = [];
    vi.resetModules();
    vi.doMock('./supabase-admin', () => ({
      createServiceRoleClient: () => ({
        from: (table: string) => {
          calls.push(['from', table]);
          return fakeBuilder(calls, result);
        },
      }),
    }));
    const mod = await import('./attention');
    return { mod, calls };
  }

  it('uses head-only count queries on orders and pipeline_jobs', async () => {
    const { mod, calls } = await live({ count: 4, error: null });
    expect(await mod.getAttentionCounts()).toEqual({
      paid_not_started: 4,
      dead_letter: 4,
      needs_refund: 4,
    });
    const selects = calls.filter((c) => c[0] === 'select');
    expect(selects).toHaveLength(3);
    for (const s of selects) {
      expect(s.slice(1)).toEqual(['id', { count: 'exact', head: true }]);
    }
    expect(calls).toContainEqual(['eq', 'status', 'paid']);
    expect(calls).toContainEqual(['eq', 'status', 'dead_letter']);
  });

  it('treats a null count as zero', async () => {
    const { mod } = await live({ count: null, error: null });
    expect((await mod.getAttentionCounts()).needs_refund).toBe(0);
  });

  it('throws when a count query errors', async () => {
    const { mod } = await live({ count: null, error: new Error('boom') });
    await expect(mod.getAttentionCounts()).rejects.toThrow('boom');
  });
});
