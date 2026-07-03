import { describe, expect, it } from 'vitest';

import { decideAdminAccess, isAdmin } from './access';

describe('isAdmin', () => {
  it('allows a profile with role admin', () => {
    expect(isAdmin({ profileRole: 'admin', email: null, allowlist: [] })).toBe(true);
  });

  it('allows an email in the allowlist (case-insensitive)', () => {
    expect(
      isAdmin({ profileRole: null, email: 'Liam@Zells.com', allowlist: ['liam@zells.com'] }),
    ).toBe(true);
  });

  it('denies a normal user', () => {
    expect(isAdmin({ profileRole: 'user', email: 'fan@example.com', allowlist: [] })).toBe(false);
  });

  it('denies when email is null and role is not admin', () => {
    expect(isAdmin({ profileRole: null, email: null, allowlist: ['liam@zells.com'] })).toBe(false);
  });
});

describe('decideAdminAccess', () => {
  const user = { id: 'u1', email: 'liam@zells.com' };

  it('returns fake when in fake mode regardless of user', () => {
    expect(
      decideAdminAccess({ fakeMode: true, user: null, profileRole: null, allowlist: [] }),
    ).toEqual({ kind: 'fake' });
  });

  it('denies when there is no signed-in user', () => {
    expect(
      decideAdminAccess({ fakeMode: false, user: null, profileRole: 'admin', allowlist: [] }),
    ).toEqual({ kind: 'deny' });
  });

  it('allows an admin by role', () => {
    expect(
      decideAdminAccess({ fakeMode: false, user, profileRole: 'admin', allowlist: [] }),
    ).toEqual({ kind: 'allow', user });
  });

  it('allows an admin by allowlist', () => {
    expect(
      decideAdminAccess({
        fakeMode: false,
        user,
        profileRole: null,
        allowlist: ['liam@zells.com'],
      }),
    ).toEqual({ kind: 'allow', user });
  });

  it('denies a signed-in non-admin', () => {
    expect(
      decideAdminAccess({
        fakeMode: false,
        user: { id: 'u2', email: 'fan@example.com' },
        profileRole: 'user',
        allowlist: ['liam@zells.com'],
      }),
    ).toEqual({ kind: 'deny' });
  });
});
