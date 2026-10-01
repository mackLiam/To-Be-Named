import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  accountFromSession,
  AuthError,
  asAuthError,
  becameMember,
  canPlaceOrder,
  fakeAuthBackend,
  normalizeCode,
  normalizeEmail,
  supabaseAuthBackend,
  type Account,
  type FakeAuthStep,
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
    ['22023', 'ERR_AUTH_TRANSFER'],
    ['42501', 'ERR_AUTH_FORBIDDEN'],
    ['23514', 'ERR_AUTH_ORDER_ACTIVE'],
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

interface Calls {
  main: unknown[][];
  throwaway: unknown[][];
}

/** A supabase client stand-in that records every call as [method, ...args]. */
function fakeClient(
  log: unknown[][],
  results: Partial<Record<string, { data?: unknown; error?: unknown }>> = {},
) {
  const call =
    (name: string) =>
    async (...args: unknown[]) => {
      log.push([name, ...args]);
      const key = name === 'rpc' ? `rpc:${String(args[0])}` : name;
      return { data: null, error: null, ...results[key] };
    };
  return {
    auth: Object.fromEntries(
      [
        'signInWithOtp',
        'verifyOtp',
        'signInAnonymously',
        'updateUser',
        'signOut',
        'setSession',
      ].map((name) => [name, call(name)]),
    ),
    rpc: call('rpc'),
  } as unknown as SupabaseClient;
}

function setupSupabase(
  mainResults: Parameters<typeof fakeClient>[1] = {},
  throwawayResults: Parameters<typeof fakeClient>[1] = {},
) {
  const calls: Calls = { main: [], throwaway: [] };
  const createThrowaway = vi.fn(() => fakeClient(calls.throwaway, throwawayResults));
  const backend = supabaseAuthBackend(fakeClient(calls.main, mainResults), createThrowaway);
  return { backend, calls, createThrowaway };
}

const MEMBER_SESSION = { access_token: 'at', refresh_token: 'rt' };

describe('supabaseAuthBackend', () => {
  it('sends a code that can create the account, then verifies it as an email OTP', async () => {
    const { backend, calls } = setupSupabase();
    await backend.sendCode('a@b.co');
    await backend.verifyCode('a@b.co', '123456');
    expect(calls.main).toEqual([
      ['signInWithOtp', { email: 'a@b.co', options: { shouldCreateUser: true } }],
      ['verifyOtp', { email: 'a@b.co', token: '123456', type: 'email' }],
    ]);
  });

  it('upgrades a guest by attaching the email and verifying an email_change code', async () => {
    const { backend, calls } = setupSupabase();
    await backend.startUpgrade('a@b.co');
    await backend.finishUpgrade('a@b.co', '123456');
    expect(calls.main).toEqual([
      ['updateUser', { email: 'a@b.co' }],
      ['verifyOtp', { email: 'a@b.co', token: '123456', type: 'email_change' }],
    ]);
  });

  it('throws a typed error when supabase returns one', async () => {
    const { backend } = setupSupabase({ verifyOtp: { error: { code: 'otp_expired' } } });
    await expect(backend.verifyCode('a@b.co', '1')).rejects.toMatchObject({
      code: 'ERR_AUTH_CODE',
    });
  });

  it('signs out this device only by default, and everywhere when asked', async () => {
    const { backend, calls } = setupSupabase();
    await backend.signOut();
    await backend.signOut('global');
    expect(calls.main).toEqual([
      ['signOut', { scope: 'local' }],
      ['signOut', { scope: 'global' }],
    ]);
  });

  it('sends the merge code from a throwaway client, never creating a user', async () => {
    const { backend, calls } = setupSupabase();
    await backend.startMerge('a@b.co');
    expect(calls.main).toEqual([]);
    expect(calls.throwaway).toEqual([
      ['signInWithOtp', { email: 'a@b.co', options: { shouldCreateUser: false } }],
    ]);
  });

  it('merges in order: begin as guest, verify and claim as member, then swap the session', async () => {
    const { backend, calls } = setupSupabase(
      { 'rpc:begin_guest_transfer': { data: 'tok' } },
      { verifyOtp: { data: { session: MEMBER_SESSION } }, 'rpc:claim_guest_transfer': { data: 2 } },
    );
    await backend.mergeGuestInto('a@b.co', '123456');
    expect(calls.main).toEqual([
      ['rpc', 'begin_guest_transfer'],
      ['setSession', { access_token: 'at', refresh_token: 'rt' }],
    ]);
    expect(calls.throwaway).toEqual([
      ['verifyOtp', { email: 'a@b.co', token: '123456', type: 'email' }],
      ['rpc', 'claim_guest_transfer', { p_token: 'tok' }],
    ]);
  });

  it.each([
    [
      'begin_guest_transfer refused',
      { 'rpc:begin_guest_transfer': { error: { code: '42501' } } },
      {},
      'ERR_AUTH_FORBIDDEN',
    ],
    ['code wrong', {}, { verifyOtp: { error: { code: 'otp_expired' } } }, 'ERR_AUTH_CODE'],
    [
      'code verified without a session',
      {},
      { verifyOtp: { data: { session: null } } },
      'ERR_AUTH_CODE',
    ],
    [
      'claim refused',
      {},
      {
        verifyOtp: { data: { session: MEMBER_SESSION } },
        'rpc:claim_guest_transfer': { error: { code: '22023' } },
      },
      'ERR_AUTH_TRANSFER',
    ],
  ])(
    'a merge failing at "%s" never touches the main session',
    async (_name, main, throwaway, code) => {
      const { backend, calls } = setupSupabase(
        { 'rpc:begin_guest_transfer': { data: 'tok' }, ...main },
        throwaway,
      );
      await expect(backend.mergeGuestInto('a@b.co', '123456')).rejects.toMatchObject({ code });
      expect(calls.main.filter(([name]) => name !== 'rpc')).toEqual([]);
    },
  );

  it('deletes the account, then signs out everywhere', async () => {
    const { backend, calls } = setupSupabase();
    await backend.deleteAccount();
    expect(calls.main).toEqual([
      ['rpc', 'request_account_deletion'],
      ['signOut', { scope: 'global' }],
    ]);
  });

  it('keeps the user signed in when deletion is refused for an active order', async () => {
    const { backend, calls } = setupSupabase({
      'rpc:request_account_deletion': { error: { code: '23514' } },
    });
    await expect(backend.deleteAccount()).rejects.toMatchObject({ code: 'ERR_AUTH_ORDER_ACTIVE' });
    expect(calls.main).toEqual([['rpc', 'request_account_deletion']]);
  });

  it('returns the data export from the RPC', async () => {
    const { backend } = setupSupabase({ 'rpc:export_my_data': { data: { scans: [] } } });
    expect(await backend.exportMyData()).toEqual({ scans: [] });
  });
});

describe('canPlaceOrder', () => {
  const guest: Account = { userId: 'g', kind: 'guest', email: null };
  const member: Account = { userId: 'm', kind: 'member', email: 'a@b.co' };

  it('allows members only', () => {
    expect(canPlaceOrder(member)).toBe(true);
    expect(canPlaceOrder(guest)).toBe(false);
    expect(canPlaceOrder(null)).toBe(false);
  });

  it('becameMember spots guest to member, by upgrade or by merge', () => {
    expect(becameMember(guest, { ...guest, kind: 'member', email: 'a@b.co' })).toBe(true);
    expect(becameMember(guest, member)).toBe(true);
    expect(becameMember(null, member)).toBe(false);
    expect(becameMember(member, member)).toBe(false);
    expect(becameMember(guest, null)).toBe(false);
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

  it('starts a merge when upgrading to an email that already has an account', async () => {
    const backend = fakeAuthBackend({ existingEmails: ['a@b.co'] });
    await backend.continueAsGuest();
    await expect(backend.startUpgrade('a@b.co')).rejects.toMatchObject({
      code: 'ERR_AUTH_EMAIL_TAKEN',
    });
    await backend.startMerge('a@b.co');
    await backend.mergeGuestInto('a@b.co', '123456');
    expect(await backend.getAccount()).toEqual({
      userId: 'fake-member-a@b.co',
      kind: 'member',
      email: 'a@b.co',
    });
  });

  it.each<FakeAuthStep>(['begin_transfer', 'verify_member', 'claim_transfer', 'set_session'])(
    'a merge failing at %s leaves the guest signed in and unchanged',
    async (failing) => {
      const fail: Partial<Record<FakeAuthStep, unknown>> = { [failing]: { code: '22023' } };
      const backend = fakeAuthBackend({ existingEmails: ['a@b.co'], fail });
      await backend.continueAsGuest();
      const guest = await backend.getAccount();
      const seen: unknown[] = [];
      backend.onChange((account) => seen.push(account));

      await expect(backend.mergeGuestInto('a@b.co', '123456')).rejects.toBeInstanceOf(AuthError);
      expect(await backend.getAccount()).toEqual(guest);
      expect(seen).toEqual([]);

      delete fail[failing];
      await backend.mergeGuestInto('a@b.co', '123456');
      expect((await backend.getAccount())?.kind).toBe('member');
    },
  );

  it('refuses deletion with an active order and keeps the account', async () => {
    const backend = fakeAuthBackend({ fail: { delete_account: { code: '23514' } } });
    await backend.verifyCode('a@b.co', '123456');
    await expect(backend.deleteAccount()).rejects.toMatchObject({ code: 'ERR_AUTH_ORDER_ACTIVE' });
    expect((await backend.getAccount())?.kind).toBe('member');
  });

  it('deletes the account and signs out', async () => {
    const backend = fakeAuthBackend();
    await backend.continueAsGuest();
    await backend.deleteAccount();
    expect(await backend.getAccount()).toBeNull();
  });
});
