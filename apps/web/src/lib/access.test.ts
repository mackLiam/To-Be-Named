import { describe, expect, it } from 'vitest';

import {
  decideAdminAccess,
  isAllowlisted,
  isTotpCode,
  pickTotpFactorId,
  staleTotpFactorIds,
} from './access';

describe('isAllowlisted', () => {
  it('matches case-insensitively', () => {
    expect(isAllowlisted('Liam@Zells.com', ['liam@zells.com'])).toBe(true);
  });

  it('rejects an email not in the list', () => {
    expect(isAllowlisted('fan@example.com', ['liam@zells.com'])).toBe(false);
  });

  it('rejects a null email', () => {
    expect(isAllowlisted(null, ['liam@zells.com'])).toBe(false);
  });

  it('rejects everyone when the list is empty', () => {
    expect(isAllowlisted('liam@zells.com', [])).toBe(false);
  });
});

describe('decideAdminAccess', () => {
  const staff = { id: 'u1', email: 'liam@zells.com', emailConfirmed: true };
  const allowlist = ['liam@zells.com'];
  const base = {
    fakeMode: false,
    user: staff,
    allowlist,
    aal: 'aal2' as const,
    hasVerifiedTotp: true,
  };

  it('returns fake in fake mode regardless of anything else', () => {
    expect(
      decideAdminAccess({ ...base, fakeMode: true, user: null, aal: null, hasVerifiedTotp: false }),
    ).toEqual({ kind: 'fake' });
  });

  it('allows an allowlisted confirmed user at aal2', () => {
    expect(decideAdminAccess(base)).toEqual({
      kind: 'allow',
      user: { id: 'u1', email: 'liam@zells.com' },
    });
  });

  it('denies when there is no signed-in user', () => {
    expect(decideAdminAccess({ ...base, user: null })).toEqual({ kind: 'deny' });
  });

  it('denies a non-allowlisted user even at aal2', () => {
    expect(decideAdminAccess({ ...base, user: { ...staff, email: 'fan@example.com' } })).toEqual({
      kind: 'deny',
    });
  });

  it('denies a user with no email', () => {
    expect(decideAdminAccess({ ...base, user: { ...staff, email: null } })).toEqual({
      kind: 'deny',
    });
  });

  it('denies an allowlisted user whose email is unconfirmed, even at aal2', () => {
    expect(decideAdminAccess({ ...base, user: { ...staff, emailConfirmed: false } })).toEqual({
      kind: 'deny',
    });
  });

  it('denies when the allowlist is empty', () => {
    expect(decideAdminAccess({ ...base, allowlist: [] })).toEqual({ kind: 'deny' });
  });

  it('denies a non-allowlisted user at aal1 instead of revealing the MFA step', () => {
    expect(
      decideAdminAccess({
        ...base,
        user: { ...staff, email: 'fan@example.com' },
        aal: 'aal1',
        hasVerifiedTotp: false,
      }),
    ).toEqual({ kind: 'deny' });
  });

  it('denies an unconfirmed allowlisted user at aal1 instead of offering enrollment', () => {
    expect(
      decideAdminAccess({
        ...base,
        user: { ...staff, emailConfirmed: false },
        aal: 'aal1',
        hasVerifiedTotp: false,
      }),
    ).toEqual({ kind: 'deny' });
  });

  it('sends staff with no verified factor to enrollment at aal1', () => {
    expect(decideAdminAccess({ ...base, aal: 'aal1', hasVerifiedTotp: false })).toEqual({
      kind: 'mfa_enroll',
    });
  });

  it('sends staff with a verified factor to verification at aal1', () => {
    expect(decideAdminAccess({ ...base, aal: 'aal1', hasVerifiedTotp: true })).toEqual({
      kind: 'mfa_verify',
    });
  });

  it('treats an unknown assurance level as not aal2', () => {
    expect(decideAdminAccess({ ...base, aal: null, hasVerifiedTotp: true })).toEqual({
      kind: 'mfa_verify',
    });
    expect(decideAdminAccess({ ...base, aal: null, hasVerifiedTotp: false })).toEqual({
      kind: 'mfa_enroll',
    });
  });
});

describe('isTotpCode', () => {
  it('accepts exactly six digits', () => {
    expect(isTotpCode('012345')).toBe(true);
  });

  it.each(['', '12345', '1234567', '12345a', ' 123456', '123 456', '１２３４５６'])(
    'rejects %j',
    (code) => {
      expect(isTotpCode(code)).toBe(false);
    },
  );
});

describe('TOTP factor selection', () => {
  const f = (id: string, status: string, created_at: string, factor_type = 'totp') => ({
    id,
    status,
    created_at,
    factor_type,
  });

  it('lists only unverified TOTP factors as stale', () => {
    expect(
      staleTotpFactorIds([
        f('a', 'verified', '2026-01-01'),
        f('b', 'unverified', '2026-01-02'),
        f('c', 'unverified', '2026-01-03', 'phone'),
      ]),
    ).toEqual(['b']);
  });

  it('prefers the verified factor over newer unverified ones', () => {
    expect(
      pickTotpFactorId([f('old', 'verified', '2026-01-01'), f('new', 'unverified', '2026-02-01')]),
    ).toBe('old');
  });

  it('falls back to the newest unverified TOTP factor', () => {
    expect(
      pickTotpFactorId([
        f('a', 'unverified', '2026-01-01T00:00:00Z'),
        f('b', 'unverified', '2026-01-02T00:00:00Z'),
        f('p', 'unverified', '2026-03-01T00:00:00Z', 'phone'),
      ]),
    ).toBe('b');
  });

  it('returns null with no TOTP factor', () => {
    expect(pickTotpFactorId([])).toBeNull();
    expect(pickTotpFactorId([f('p', 'verified', '2026-01-01', 'phone')])).toBeNull();
  });
});
