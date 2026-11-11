import { describe, expect, it } from 'vitest';

import {
  accountStateLabel,
  normalizeCustomerRow,
  parseCustomerQuery,
  scanSummary,
} from './customers';

describe('parseCustomerQuery', () => {
  it('is empty with no text, prefix by default, exact on request', () => {
    expect(parseCustomerQuery(undefined, undefined)).toEqual({ kind: 'empty' });
    expect(parseCustomerQuery('  ', 'exact')).toEqual({ kind: 'empty' });
    expect(parseCustomerQuery(' Ops.Alpha ', undefined)).toEqual({
      kind: 'search',
      email: 'ops.alpha',
      exact: false,
    });
    expect(parseCustomerQuery('a@b.co', 'exact')).toEqual({
      kind: 'search',
      email: 'a@b.co',
      exact: true,
    });
  });

  it('bounds the length like the SQL function and rejects spaces', () => {
    expect(parseCustomerQuery('ab', undefined).kind).toBe('invalid');
    expect(parseCustomerQuery('a'.repeat(321), undefined).kind).toBe('invalid');
    expect(parseCustomerQuery('a'.repeat(320), undefined).kind).toBe('search');
    expect(parseCustomerQuery('a b@c.d', undefined)).toEqual({
      kind: 'invalid',
      error: 'An email has no spaces.',
    });
  });
});

describe('account state and scans', () => {
  const base = { is_anonymous: false, deletion_requested_at: null, deletion_reason: null };

  it('labels members, guests and pending deletions', () => {
    expect(accountStateLabel(base)).toBe('Member');
    expect(accountStateLabel({ ...base, is_anonymous: true })).toBe('Guest');
    expect(
      accountStateLabel({
        ...base,
        deletion_requested_at: '2026-01-01',
        deletion_reason: 'user_request',
      }),
    ).toBe('Deletion requested');
    expect(
      accountStateLabel({
        ...base,
        deletion_requested_at: '2026-01-01',
        deletion_reason: 'abandoned_guest',
      }),
    ).toBe('Deletion queued (abandoned guest)');
  });

  it('summarizes scans in a stable order', () => {
    expect(scanSummary({ failed: 1, ready: 2, zz: 1 })).toBe('2 ready, 1 failed, 1 zz');
    expect(scanSummary({})).toBe('none');
    expect(scanSummary(null)).toBe('none');
    expect(scanSummary({ ready: 0 })).toBe('none');
  });

  it('normalizes bigint strings from PostgREST', () => {
    expect(
      normalizeCustomerRow({
        user_id: 'u1',
        email: 'a@b.co',
        is_anonymous: false,
        created_at: '2026-01-01T00:00:00Z',
        deletion_requested_at: null,
        deletion_reason: null,
        order_count: '3',
        open_order_count: 1,
        scan_count: '2',
        scan_statuses: { ready: '2' },
      }),
    ).toEqual({
      user_id: 'u1',
      email: 'a@b.co',
      is_anonymous: false,
      created_at: '2026-01-01T00:00:00Z',
      deletion_requested_at: null,
      deletion_reason: null,
      order_count: 3,
      open_order_count: 1,
      scan_count: 2,
      scan_statuses: { ready: 2 },
    });
  });
});
