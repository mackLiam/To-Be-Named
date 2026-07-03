import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertNoPublicServiceKey,
  getAdminAllowlist,
  hasServiceRoleConfig,
  hasSupabaseConfig,
  isFakeMode,
} from './env';

const KEYS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ADMIN_ALLOWLIST',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe('supabase config gating', () => {
  it('reports no config and fake mode when env is absent', () => {
    expect(hasSupabaseConfig()).toBe(false);
    expect(isFakeMode()).toBe(true);
  });

  it('reports config present when both public vars are set', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    expect(hasSupabaseConfig()).toBe(true);
    expect(isFakeMode()).toBe(false);
  });

  it('needs a service key and a url for service role config', () => {
    expect(hasServiceRoleConfig()).toBe(false);
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    expect(hasServiceRoleConfig()).toBe(false);
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    expect(hasServiceRoleConfig()).toBe(true);
  });
});

describe('admin allowlist parsing', () => {
  it('returns an empty list when unset', () => {
    expect(getAdminAllowlist()).toEqual([]);
  });

  it('splits, trims, and lowercases entries', () => {
    process.env.ADMIN_ALLOWLIST = ' Liam@Zells.com , ops@zells.com ,, ';
    expect(getAdminAllowlist()).toEqual(['liam@zells.com', 'ops@zells.com']);
  });
});

describe('assertNoPublicServiceKey', () => {
  it('passes for benign public vars', () => {
    expect(() =>
      assertNoPublicServiceKey({
        NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
        NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      }),
    ).not.toThrow();
  });

  it('throws if a service key is exposed via NEXT_PUBLIC', () => {
    expect(() =>
      assertNoPublicServiceKey({ NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: 'leaked' }),
    ).toThrow(/never be exposed/i);
  });

  it('throws for a NEXT_PUBLIC secret of any name', () => {
    expect(() => assertNoPublicServiceKey({ NEXT_PUBLIC_STRIPE_SECRET: 'leaked' })).toThrow();
  });
});
