import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  accountFromSession,
  AuthError,
  asAuthError,
  fakeAuthBackend,
  normalizeCode,
  normalizeEmail,
  supabaseAuthBackend,
} from './auth';

function session(user: Partial<Session['user']>): Session {
  return { user: { id: 'u1', ...user } } as Session;
}

describe('accountFromSession', () => {
  it('is null when signed out', () => {
    expect(accountFromSession(null)).toBeNull();
  });

  it('maps an anonymous user to a guest with no email, even mid-upgrade', () => {
    expect(accountFromSession(session({ is_anonymous: true, email: 'pending@x.com' }))).toEqual({
      userId: 'u1',
      kind: 'guest',
      email: null,
    });
  });

  it('maps an email user to a member', () => {
    expect(accountFromSession(session({ is_anonymous: false, email: 'a@b.co' }))).toEqual({
      userId: 'u1',
      kind: 'member',
      email: 'a@b.co',
    });
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Parent@Example.COM ')).toBe('parent@example.com');
  });

  it.each(['', 'nope', 'a@b', 'a b@c.com', '@c.com', `${'a'.repeat(250)}@c.com`])(
    'rejects %j',
    (input) => {
      expect(normalizeEmail(input)).toBeNull();
    },
  );
});

describe('normalizeCode', () => {
  it('accepts 6 to 10 digits, ignoring spaces', () => {
    expect(normalizeCode('123 456')).toBe('123456');
    expect(normalizeCode('1234567890')).toBe('1234567890');
  });

  it.each(['12345', '12345678901', 'abcdef', '12345a'])('rejects %j', (input) => {
    expect(normalizeCode(input)).toBeNull();
  });
});

describe('asAuthError', () => {
  it.each([
    ['otp_expired', 'ERR_AUTH_CODE'],
    ['over_email_send_rate_limit', 'ERR_AUTH_RATE_LIMIT'],
    ['email_exists', 'ERR_AUTH_EMAIL_TAKEN'],
    ['anonymous_provider_disabled', 'ERR_AUTH_GUEST_DISABLED'],
    ['email_address_invalid', 'ERR_AUTH_EMAIL'],
    ['something_new', 'ERR_AUTH_UNKNOWN'],
  ])('maps %s to %s', (code, expected) => {
    expect(asAuthError({ code }).code).toBe(expected);
  });

  it('maps a non-object throw to unknown and passes AuthError through', () => {
    expect(asAuthError('boom').code).toBe('ERR_AUTH_UNKNOWN');
    const typed = new AuthError('ERR_AUTH_CODE');
    expect(asAuthError(typed)).toBe(typed);
  });
});

function fakeSupabaseAuth(error: unknown = null) {
  const ok = vi.fn(async () => ({ data: {}, error }));
  const auth = {
    signInWithOtp: ok,
    verifyOtp: ok,
    signInAnonymously: ok,
    updateUser: ok,
    signOut: ok,
  };
  return { auth: auth as unknown as SupabaseClient['auth'], calls: ok.mock.calls };
}

describe('supabaseAuthBackend', () => {
  it('sends a code that can create the account, then verifies it as an email OTP', async () => {
    const { auth, calls } = fakeSupabaseAuth();
    const backend = supabaseAuthBackend(auth);
    await backend.sendCode('a@b.co');
    await backend.verifyCode('a@b.co', '123456');
    expect(calls).toEqual([
      [{ email: 'a@b.co', options: { shouldCreateUser: true } }],
      [{ email: 'a@b.co', token: '123456', type: 'email' }],
    ]);
  });

  it('upgrades a guest by attaching the email and verifying an email_change code', async () => {
    const { auth, calls } = fakeSupabaseAuth();
    const backend = supabaseAuthBackend(auth);
    await backend.startUpgrade('a@b.co');
    await backend.finishUpgrade('a@b.co', '123456');
    expect(calls).toEqual([
      [{ email: 'a@b.co' }],
      [{ email: 'a@b.co', token: '123456', type: 'email_change' }],
    ]);
  });

  it('throws a typed error when supabase returns one', async () => {
    const { auth } = fakeSupabaseAuth({ code: 'otp_expired' });
    await expect(supabaseAuthBackend(auth).verifyCode('a@b.co', '1')).rejects.toMatchObject({
      code: 'ERR_AUTH_CODE',
    });
  });
});

describe('fakeAuthBackend', () => {
  it('runs guest, upgrade and sign-out, keeping the user id across the upgrade', async () => {
    const backend = fakeAuthBackend();
    const seen: unknown[] = [];
    backend.onChange((account) => seen.push(account));

    await backend.continueAsGuest();
    const guest = await backend.getAccount();
    expect(guest?.kind).toBe('guest');

    await backend.startUpgrade('a@b.co');
    await backend.finishUpgrade('a@b.co', '123456');
    const member = await backend.getAccount();
    expect(member).toEqual({ userId: guest?.userId, kind: 'member', email: 'a@b.co' });

    await backend.signOut();
    expect(await backend.getAccount()).toBeNull();
    expect(seen).toHaveLength(3);
  });

  it('rejects finishing an upgrade for an email that was never started', async () => {
    const backend = fakeAuthBackend();
    await backend.continueAsGuest();
    await expect(backend.finishUpgrade('a@b.co', '123456')).rejects.toMatchObject({
      code: 'ERR_AUTH_CODE',
    });
  });
});
