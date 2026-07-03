import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTriage, isValidJobState, listOrders, listPipelineJobs } from './data';
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
