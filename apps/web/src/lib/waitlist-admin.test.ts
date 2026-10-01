import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FAKE_WAITLIST, listWaitlist, parseInterest } from './waitlist-admin';

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

describe('parseInterest', () => {
  it('accepts only the allowlist', () => {
    expect(parseInterest('pro')).toBe('pro');
    expect(parseInterest('junior_max')).toBe('junior_max');
    expect(parseInterest('everyone')).toBeUndefined();
    expect(parseInterest('')).toBeUndefined();
    expect(parseInterest(undefined)).toBeUndefined();
  });
});

describe('listWaitlist fake mode', () => {
  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
  });

  it('counts per interest and lists newest first', async () => {
    const v = await listWaitlist({ actor: 'a', page: 1, pageSize: 25 });
    expect(v.counts).toEqual({ launch: 2, pro: 1, junior_max: 1 });
    expect(v.rows).toHaveLength(FAKE_WAITLIST.length);
    expect(v.hasNext).toBe(false);
  });

  it('filters by interest', async () => {
    const v = await listWaitlist({ actor: 'a', interest: 'launch', page: 1, pageSize: 25 });
    expect(v.rows.every((r) => r.interest === 'launch')).toBe(true);
    expect(v.rows).toHaveLength(2);
  });

  it('paginates with lookahead', async () => {
    const p1 = await listWaitlist({ actor: 'a', page: 1, pageSize: 3 });
    expect(p1.rows).toHaveLength(3);
    expect(p1.hasNext).toBe(true);
    const p2 = await listWaitlist({ actor: 'a', page: 2, pageSize: 3 });
    expect(p2.rows).toHaveLength(1);
    expect(p2.hasNext).toBe(false);
  });
});

describe('listWaitlist live mode', () => {
  async function live(opts: { listError?: unknown; auditError?: unknown } = {}) {
    for (const k of ENV) process.env[k] = 'x';
    const calls: [string, ...unknown[]][] = [];
    const rows = [1, 2, 3].map((id) => ({
      id,
      email: `e${id}@example.com`,
      interest: 'pro',
      created_at: '2026-09-01T00:00:00Z',
    }));
    const builder = (result: unknown) => {
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'range']) {
        b[m] = (...args: unknown[]) => {
          calls.push([m, ...args]);
          return b;
        };
      }
      b.then = (resolve: (v: unknown) => unknown) => resolve(result);
      return b;
    };
    vi.resetModules();
    vi.doMock('./supabase-admin', () => ({
      createServiceRoleClient: () => ({
        from: (table: string) => {
          calls.push(['from', table]);
          if (table === 'audit_log') {
            return {
              insert: async (row: unknown) => {
                calls.push(['insert', row]);
                return { error: opts.auditError ?? null };
              },
            };
          }
          const b = builder({ data: rows, count: 7, error: opts.listError ?? null });
          return b;
        },
      }),
    }));
    const mod = await import('./waitlist-admin');
    return { mod, calls };
  }

  it('writes one audit row and bounds the read', async () => {
    const { mod, calls } = await live();
    const v = await mod.listWaitlist({ actor: 'ops@x', interest: 'pro', page: 2, pageSize: 2 });
    expect(v.rows).toHaveLength(2);
    expect(v.hasNext).toBe(true);
    expect(v.counts).toEqual({ launch: 7, pro: 7, junior_max: 7 });
    expect(calls).toContainEqual(['range', 2, 4]);
    const inserts = calls.filter((c) => c[0] === 'insert');
    expect(inserts).toEqual([
      [
        'insert',
        {
          actor: 'ops@x',
          action: 'waitlist.view',
          subject_table: null,
          detail: { interest: 'pro', page: 2 },
        },
      ],
    ]);
  });

  it('throws on a query error and writes no audit row', async () => {
    const { mod, calls } = await live({ listError: new Error('db down') });
    await expect(mod.listWaitlist({ actor: 'a', page: 1, pageSize: 25 })).rejects.toThrow(
      'db down',
    );
    expect(calls.some((c) => c[0] === 'insert')).toBe(false);
  });

  it('throws when the audit row cannot be written', async () => {
    const { mod } = await live({ auditError: new Error('audit down') });
    await expect(mod.listWaitlist({ actor: 'a', page: 1, pageSize: 25 })).rejects.toThrow(
      'audit down',
    );
  });
});
