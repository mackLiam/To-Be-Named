/**
 * Accounts (docs/DESIGN.md section 4: Supabase Auth, email one-time code;
 * Sign in with Apple joins once the Apple Developer account exists).
 *
 * Two kinds of signed-in user, both real Supabase auth users:
 * - guest: an anonymous sign-in. It has an auth.uid(), so the existing RLS
 *   policies (0002, 0003) already scope its scans, orders and mesh uploads to
 *   it with no schema change. It lives only in this device's session: signing
 *   out or reinstalling loses access for good.
 * - member: signed in with an email address. Same library on every device.
 *
 * A guest becomes a member by attaching an email (updateUser + email_change
 * code). The user id does not change, so every scan and order the guest made
 * is already the member's. That one-boundary property is why guests are
 * anonymous auth users and not a client-side "no account" mode.
 *
 * When that email already belongs to a member, the guest's scans move to the
 * member instead (mergeGuestInto, migration 0012 transfer RPCs). Payment
 * needs a member: the orders insert policy refuses guests (0012), and the app
 * says so wherever ordering is mentioned (canPlaceOrder).
 *
 * Sensitive-data note: nothing here logs an email, a code, or a token.
 */

import type { Session, SupabaseClient } from '@supabase/supabase-js';

import { BRAND_NAME } from '@forms/shared/brand';

import { createThrowawayClient, getSupabaseClient, hasSupabaseConfig } from './supabase';

export type AccountKind = 'guest' | 'member';

export interface Account {
  userId: string;
  kind: AccountKind;
  /** Null for a guest. */
  email: string | null;
}

export function accountFromSession(session: Session | null): Account | null {
  if (!session) {
    return null;
  }
  const { user } = session;
  // An anonymous user with an email attached but not yet confirmed is still a
  // guest: the email only counts once the code is verified.
  const kind: AccountKind = user.is_anonymous ? 'guest' : 'member';
  return { userId: user.id, kind, email: kind === 'member' ? (user.email ?? null) : null };
}

/** Payment needs an account (orders RLS, migration 0012). Checkout reuses this. */
export function canPlaceOrder(account: Account | null): boolean {
  return account?.kind === 'member';
}

/** True when a guest just became a member, by upgrade in place or by merge. */
export function becameMember(previous: Account | null, next: Account | null): boolean {
  return previous?.kind === 'guest' && next?.kind === 'member';
}

/** Trimmed, lower-cased email, or null when it is not plausibly an address.
 * Deliberately loose: the server is the real check, this only stops typos
 * from spending a rate-limited send. */
export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  return email;
}

/** Supabase email OTP length is configurable from 6 to 10 digits. */
export function normalizeCode(input: string): string | null {
  const code = input.replace(/\s/g, '');
  return /^\d{6,10}$/.test(code) ? code : null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AuthErrorCode =
  | 'ERR_AUTH_EMAIL'
  | 'ERR_AUTH_CODE'
  | 'ERR_AUTH_RATE_LIMIT'
  | 'ERR_AUTH_EMAIL_TAKEN'
  | 'ERR_AUTH_GUEST_DISABLED'
  | 'ERR_AUTH_TRANSFER'
  | 'ERR_AUTH_FORBIDDEN'
  | 'ERR_AUTH_ORDER_ACTIVE'
  | 'ERR_AUTH_UNKNOWN';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message = AUTH_ERROR_MESSAGES[code]) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  ERR_AUTH_EMAIL: 'That email address does not look right. Check it and try again.',
  ERR_AUTH_CODE: 'That code is wrong or has expired. Check it, or send a new code.',
  ERR_AUTH_RATE_LIMIT: 'Too many attempts. Wait a few minutes, then try again.',
  ERR_AUTH_EMAIL_TAKEN: `That email already has a ${BRAND_NAME} account. Sign in with it instead.`,
  ERR_AUTH_GUEST_DISABLED:
    'Guest access is switched off right now. Sign in with your email instead.',
  ERR_AUTH_TRANSFER:
    'Your scans did not move, and nothing has changed. Send a new code and try again.',
  ERR_AUTH_FORBIDDEN: 'This account cannot do that. Sign out, sign in again, then retry.',
  ERR_AUTH_ORDER_ACTIVE:
    'You have an order being made or on its way. You can delete your account once it is delivered, or contact support.',
  ERR_AUTH_UNKNOWN: 'That did not work. Check your connection and try again.',
};

/** Map a supabase-js auth error (by its stable `code`) or an account RPC
 * error (by its SQLSTATE, migration 0012) to a typed error. */
export function asAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) {
    return error;
  }
  const code = (error as { code?: unknown } | null)?.code;
  switch (code) {
    case 'otp_expired':
    case 'invalid_credentials':
      return new AuthError('ERR_AUTH_CODE');
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
      return new AuthError('ERR_AUTH_RATE_LIMIT');
    case 'email_exists':
    case 'user_already_exists':
      return new AuthError('ERR_AUTH_EMAIL_TAKEN');
    case 'email_address_invalid':
    case 'validation_failed':
      return new AuthError('ERR_AUTH_EMAIL');
    case 'anonymous_provider_disabled':
      return new AuthError('ERR_AUTH_GUEST_DISABLED');
    // claim_guest_transfer: token unknown, expired or already used.
    case '22023':
      return new AuthError('ERR_AUTH_TRANSFER');
    // Transfer RPCs called by the wrong kind of user.
    case '42501':
      return new AuthError('ERR_AUTH_FORBIDDEN');
    // request_account_deletion: an order is paid, in production or shipped.
    case '23514':
      return new AuthError('ERR_AUTH_ORDER_ACTIVE');
    default:
      return new AuthError('ERR_AUTH_UNKNOWN');
  }
}

// ---------------------------------------------------------------------------
// Backend seam
// ---------------------------------------------------------------------------

/** local: this device only. global: every device signed in to the account. */
export type SignOutScope = 'local' | 'global';

/** Shape returned by export_my_data (migration 0012). Opaque to the app: it
 * is handed to the user as is. */
export type DataExport = Record<string, unknown>;

export interface AuthBackend {
  getAccount(): Promise<Account | null>;
  /** Subscribe to sign-in, sign-out and upgrade. Returns the unsubscribe. */
  onChange(listener: (account: Account | null) => void): () => void;
  /** Email a one-time code. Creates the account on first use, so sign-in and
   * sign-up are one flow. */
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<void>;
  continueAsGuest(): Promise<void>;
  /** Guest only: email a code that attaches this address to the guest user. */
  startUpgrade(email: string): Promise<void>;
  finishUpgrade(email: string, code: string): Promise<void>;
  /** Guest only, email already a member: email a sign-in code for that
   * member without creating a user or touching the current session. */
  startMerge(email: string): Promise<void>;
  /** Guest only: sign in as that member and move this guest's scans to it.
   * Any failure leaves the guest session exactly as it was. */
  mergeGuestInto(email: string, code: string): Promise<void>;
  signOut(scope?: SignOutScope): Promise<void>;
  /** Request erasure (server side, finishes within days), then sign out
   * everywhere. Refused while an order is being made or shipped. */
  deleteAccount(): Promise<void>;
  exportMyData(): Promise<DataExport>;
}

async function unwrap<R extends { data?: unknown; error: unknown }>(
  call: PromiseLike<R>,
): Promise<R['data']> {
  const { data, error } = await call;
  if (error) {
    throw asAuthError(error);
  }
  return data;
}

export function supabaseAuthBackend(
  client: SupabaseClient,
  createThrowaway: () => SupabaseClient,
): AuthBackend {
  const { auth } = client;
  return {
    async getAccount() {
      const { data } = await auth.getSession();
      return accountFromSession(data.session);
    },
    onChange(listener) {
      const { data } = auth.onAuthStateChange((_event, session) => {
        listener(accountFromSession(session));
      });
      return () => data.subscription.unsubscribe();
    },
    sendCode: (email) =>
      unwrap(auth.signInWithOtp({ email, options: { shouldCreateUser: true } })).then(() => {}),
    verifyCode: (email, token) =>
      unwrap(auth.verifyOtp({ email, token, type: 'email' })).then(() => {}),
    continueAsGuest: () => unwrap(auth.signInAnonymously()).then(() => {}),
    startUpgrade: (email) => unwrap(auth.updateUser({ email })).then(() => {}),
    finishUpgrade: (email, token) =>
      unwrap(auth.verifyOtp({ email, token, type: 'email_change' })).then(() => {}),
    startMerge: (email) =>
      unwrap(
        createThrowaway().auth.signInWithOtp({ email, options: { shouldCreateUser: false } }),
      ).then(() => {}),
    async mergeGuestInto(email, token) {
      // Order is the safety property: only the last step changes what the app
      // sees, so a failure before it leaves the guest signed in to retry.
      const transfer: unknown = await unwrap(client.rpc('begin_guest_transfer'));
      if (typeof transfer !== 'string' || transfer === '') {
        throw new AuthError('ERR_AUTH_UNKNOWN');
      }
      const member = createThrowaway();
      const { session } = await unwrap(member.auth.verifyOtp({ email, token, type: 'email' }));
      if (!session) {
        throw new AuthError('ERR_AUTH_CODE');
      }
      await unwrap(member.rpc('claim_guest_transfer', { p_token: transfer }));
      await unwrap(
        auth.setSession({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        }),
      );
    },
    signOut: (scope = 'local') => unwrap(auth.signOut({ scope })).then(() => {}),
    async deleteAccount() {
      await unwrap(client.rpc('request_account_deletion'));
      await unwrap(auth.signOut({ scope: 'global' }));
    },
    exportMyData: async (): Promise<DataExport> =>
      (await unwrap(client.rpc('export_my_data'))) ?? {},
  };
}

/** Steps a test can make fail in the fake backend. */
export type FakeAuthStep =
  | 'send_code'
  | 'verify_code'
  | 'begin_transfer'
  | 'verify_member'
  | 'claim_transfer'
  | 'set_session'
  | 'delete_account'
  | 'export';

export interface FakeAuthOptions {
  /** Emails that already have an account: upgrading to one starts a merge. */
  existingEmails?: string[];
  /** Mutable: a step listed here throws this error (mapped by asAuthError). */
  fail?: Partial<Record<FakeAuthStep, unknown>>;
}

/**
 * FAKE MODE: no backend configured. An in-memory stand-in so the sign-in
 * screens run in local dev and CI with zero credentials: any well-formed code
 * is accepted and nothing is persisted, so every app launch starts signed out.
 */
export function fakeAuthBackend(options: FakeAuthOptions = {}): AuthBackend {
  const existing = new Set(options.existingEmails ?? []);
  const fail = options.fail ?? {};
  let account: Account | null = null;
  let pendingUpgrade: string | null = null;
  const listeners = new Set<(account: Account | null) => void>();
  const set = (next: Account | null) => {
    account = next;
    listeners.forEach((listener) => listener(next));
  };
  const step = (name: FakeAuthStep) => {
    if (name in fail) {
      throw asAuthError(fail[name]);
    }
  };
  return {
    getAccount: async () => account,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async sendCode() {
      step('send_code');
    },
    async verifyCode(email) {
      step('verify_code');
      existing.add(email);
      set({ userId: `fake-member-${email}`, kind: 'member', email });
    },
    async continueAsGuest() {
      set({ userId: 'fake-guest', kind: 'guest', email: null });
    },
    async startUpgrade(email) {
      step('send_code');
      if (existing.has(email)) {
        throw new AuthError('ERR_AUTH_EMAIL_TAKEN');
      }
      pendingUpgrade = email;
    },
    async finishUpgrade(email) {
      step('verify_code');
      if (!account || pendingUpgrade !== email) {
        throw new AuthError('ERR_AUTH_CODE');
      }
      pendingUpgrade = null;
      existing.add(email);
      set({ ...account, kind: 'member', email });
    },
    async startMerge() {
      step('send_code');
    },
    async mergeGuestInto(email) {
      if (account?.kind !== 'guest') {
        throw new AuthError('ERR_AUTH_FORBIDDEN');
      }
      step('begin_transfer');
      step('verify_member');
      if (!existing.has(email)) {
        throw new AuthError('ERR_AUTH_CODE');
      }
      step('claim_transfer');
      step('set_session');
      set({ userId: `fake-member-${email}`, kind: 'member', email });
    },
    async signOut() {
      set(null);
    },
    async deleteAccount() {
      step('delete_account');
      if (account?.email) {
        existing.delete(account.email);
      }
      set(null);
    },
    async exportMyData() {
      step('export');
      return {
        exported_at: new Date().toISOString(),
        account: account && {
          user_id: account.userId,
          email: account.email,
          is_anonymous: account.kind === 'guest',
        },
        profile: null,
        scans: [],
        measurements: [],
        orders: [],
      };
    },
  };
}

let backend: AuthBackend | null = null;

export function getAuthBackend(): AuthBackend {
  backend ??= hasSupabaseConfig()
    ? supabaseAuthBackend(getSupabaseClient(), createThrowawayClient)
    : fakeAuthBackend({ existingEmails: [FAKE_EXISTING_EMAIL] });
  return backend;
}

export const IS_FAKE_AUTH = !hasSupabaseConfig();

/** Fake mode only: saving a guest to this address runs the merge path. */
export const FAKE_EXISTING_EMAIL = 'member@example.com';
