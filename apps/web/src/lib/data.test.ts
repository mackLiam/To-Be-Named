import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getOrderDetail,
  getOrderTimeline,
  getTriage,
  isValidJobState,
  listMainImages,
  listOrders,
  listPipelineJobs,
  listProductImages,
  listProducts,
  lookupCustomerEmail,
  searchCustomers,
} from './data';
import { FAKE_CUSTOMER_ID, FAKE_TRIAGE_JOB_ID, fakeJobs, fakeOrders } from './fake';

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

  it('filters by customer and ignores a malformed customer id', async () => {
    const mine = await listOrders({ userId: FAKE_CUSTOMER_ID, page: 1, pageSize: 100 });
    expect(mine.rows.length).toBe(fakeOrders.filter((o) => o.user_id === FAKE_CUSTOMER_ID).length);
    expect(mine.rows.every((o) => o.user_id === FAKE_CUSTOMER_ID)).toBe(true);
    const all = await listOrders({ userId: 'not-a-uuid', page: 1, pageSize: 100 });
    expect(all.rows.length).toBe(fakeOrders.length);
  });

  it('carries the remake link', async () => {
    const { rows } = await listOrders({ page: 1, pageSize: 100 });
    const remake = rows.find((o) => o.remake_of);
    expect(remake).toMatchObject({ amount_cents: 0, remake_reason: 'fit_too_tight' });
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
    expect(order!.deletion_pending).toBe(false);
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

describe('order support reads (fake fallback)', () => {
  const ORIGINAL = '00000000-0000-4000-8000-0000000000a1';

  it('lists the remakes of an order and its refund ledger', async () => {
    const original = await getOrderDetail(ORIGINAL);
    expect(original!.remakes.map((r) => r.id)).toEqual(['00000000-0000-4000-8000-0000000000a8']);
    const withRefund = await getOrderDetail('00000000-0000-4000-8000-0000000000a3');
    expect(withRefund!.refunds).toHaveLength(1);
    expect(withRefund!.stripe_refunded_cents).toBe(2000);
    const remake = await getOrderDetail('00000000-0000-4000-8000-0000000000a8');
    expect(remake!.stripe_payment_intent).toBeNull();
  });

  it('pages the timeline with a lookahead', async () => {
    const first = await getOrderTimeline(ORIGINAL, 1, 1);
    expect(first.rows).toHaveLength(1);
    expect(first.hasNext).toBe(true);
    const second = await getOrderTimeline(ORIGINAL, 2, 1);
    expect(second.hasNext).toBe(false);
    expect(await getOrderTimeline('bad', 1, 25)).toEqual({ rows: [], page: 1, hasNext: false });
  });

  it('searches customers by prefix or exactly, paginated', async () => {
    const prefix = await searchCustomers({ email: 'FAKE.', exact: false, page: 1, pageSize: 1 });
    expect(prefix.rows).toHaveLength(1);
    expect(prefix.hasNext).toBe(true);
    const exact = await searchCustomers({
      email: 'fake.leaving@example.com',
      exact: true,
      page: 1,
      pageSize: 25,
    });
    expect(exact.rows.map((r) => r.deletion_reason)).toEqual(['user_request']);
    expect(
      (await searchCustomers({ email: 'fake.', exact: true, page: 1, pageSize: 25 })).rows,
    ).toEqual([]);
  });
});
