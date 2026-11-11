import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getOrderDetail,
  getTriage,
  isValidJobState,
  listMainImages,
  listOrders,
  listPipelineJobs,
  listProductImages,
  listProducts,
  lookupCustomerEmail,
} from './data';
import { FAKE_TRIAGE_JOB_ID, fakeJobs } from './fake';

// No Supabase env is set, so every call runs in the fake-data fallback. This
// verifies the fallback selection (no network, deterministic fixtures) and the
// bounded pagination behavior, without importing any server-only module.
const ENV_KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('isValidJobState', () => {
  it('accepts known queue states and rejects the rest', () => {
    expect(isValidJobState('dead_letter')).toBe(true);
    expect(isValidJobState('pending')).toBe(true);
    expect(isValidJobState('bogus')).toBe(false);
    expect(isValidJobState(undefined)).toBe(false);
  });
});

describe('listPipelineJobs (fake fallback)', () => {
  it('returns fake jobs when no backend is configured', async () => {
    const { rows } = await listPipelineJobs({ page: 1, pageSize: 100 });
    expect(rows.length).toBe(fakeJobs.length);
  });

  it('filters by state', async () => {
    const { rows } = await listPipelineJobs({ state: 'dead_letter', page: 1, pageSize: 100 });
    expect(rows.every((row) => row.status === 'dead_letter')).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('paginates with a bounded page size and reports hasNext', async () => {
    const first = await listPipelineJobs({ page: 1, pageSize: 2 });
    expect(first.rows.length).toBe(2);
    expect(first.hasNext).toBe(true);

    const second = await listPipelineJobs({ page: 2, pageSize: 2 });
    expect(second.rows.length).toBe(2);
    expect(second.rows[0]!.id).not.toBe(first.rows[0]!.id);
  });
});

describe('listOrders (fake fallback)', () => {
  it('returns fake orders', async () => {
    const { rows } = await listOrders({ page: 1, pageSize: 100 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('status');
  });
});

describe('getTriage (fake fallback)', () => {
  it('returns gates and the 25 values for the failed measure job', async () => {
    const triage = await getTriage(FAKE_TRIAGE_JOB_ID);
    expect(triage).not.toBeNull();
    expect(triage!.gates.length).toBeGreaterThan(0);
    expect(triage!.values).not.toBeNull();
    expect(triage!.values!.S1_ISW).toBe(12);
  });

  it('returns null for an unknown job', async () => {
    expect(await getTriage('does-not-exist')).toBeNull();
  });
});

describe('lookupCustomerEmail', () => {
  function auth(impl: (id: string) => unknown) {
    const calls: string[] = [];
    return {
      calls,
      api: {
        async getUserById(id: string) {
          calls.push(id);
          return impl(id) as { data: { user: { email?: string | null } | null }; error: unknown };
        },
      },
    };
  }

  it('never calls the auth API for a deleted account (null user_id)', async () => {
    const a = auth(() => {
      // auth-js throws synchronously on a non-uuid id; this is the old crash.
      throw new Error('@supabase/auth-js: Expected parameter to be UUID but is not');
    });
    expect(await lookupCustomerEmail(a.api, null)).toBeNull();
    expect(a.calls).toEqual([]);
  });

  it('returns the email, or null when the user or lookup is gone', async () => {
    const found = auth(() => ({ data: { user: { email: 'kid@example.com' } }, error: null }));
    expect(await lookupCustomerEmail(found.api, 'u1')).toBe('kid@example.com');
    const gone = auth(() => ({ data: { user: null }, error: { status: 404 } }));
    expect(await lookupCustomerEmail(gone.api, 'u1')).toBeNull();
    const broken = auth(() => {
      throw new Error('network');
    });
    expect(await lookupCustomerEmail(broken.api, 'u1')).toBeNull();
  });
});

describe('getOrderDetail (fake fallback)', () => {
  it('renders an order whose customer deleted their account', async () => {
    const order = await getOrderDetail('00000000-0000-4000-8000-0000000000a7');
    expect(order).not.toBeNull();
    expect(order!.user_id).toBeNull();
    expect(order!.customer_email).toBeNull();
  });
});

describe('catalog reads (fake fallback)', () => {
  const C1 = '00000000-0000-4000-8000-0000000000c1';

  it('lists products in shop order', async () => {
    const rows = await listProducts();
    expect(rows.map((row) => row.display_order)).toEqual(
      [...rows.map((row) => row.display_order)].sort((a, b) => a - b),
    );
  });

  it('lists one product gallery in order, and nothing for a bad id', async () => {
    const images = await listProductImages(C1);
    expect(images.map((row) => row.sort_order)).toEqual([0, 1]);
    expect(await listProductImages('not-a-uuid')).toEqual([]);
  });

  it('maps main images by product', async () => {
    const mains = await listMainImages([C1, 'junk']);
    expect(mains.get(C1)?.is_main).toBe(true);
    expect(mains.size).toBe(1);
    expect((await listMainImages([])).size).toBe(0);
  });
});
