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
 * Sensitive-data note: nothing here logs an email, a code, or a token.
 */

import type { Session, SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseClient, hasSupabaseConfig } from './supabase';

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
  ERR_AUTH_EMAIL: 'That does not look like an email address. Check it and try again.',
  ERR_AUTH_CODE: 'That code is wrong or has expired. Check the latest email, or send a new code.',
  ERR_AUTH_RATE_LIMIT: 'Too many codes sent. Wait a minute, then try again.',
  ERR_AUTH_EMAIL_TAKEN:
    'That email already has an account. Sign out and sign in with it instead. Scans taken as a guest stay with the guest session.',
  ERR_AUTH_GUEST_DISABLED: 'Guest access is switched off right now. Sign in with your email.',
  ERR_AUTH_UNKNOWN: 'Something went wrong. Check your connection and try again.',
};

/** Map a supabase-js auth error (by its stable `code`) to a typed error. */
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
    default:
      return new AuthError('ERR_AUTH_UNKNOWN');
  }
}

// ---------------------------------------------------------------------------
// Backend seam
// ---------------------------------------------------------------------------

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
  signOut(): Promise<void>;
}

type Auth = SupabaseClient['auth'];

async function unwrap(call: Promise<{ error: unknown }>): Promise<void> {
  const { error } = await call;
  if (error) {
    throw asAuthError(error);
  }
}

export function supabaseAuthBackend(auth: Auth): AuthBackend {
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
    sendCode: (email) => unwrap(auth.signInWithOtp({ email, options: { shouldCreateUser: true } })),
    verifyCode: (email, token) => unwrap(auth.verifyOtp({ email, token, type: 'email' })),
    continueAsGuest: () => unwrap(auth.signInAnonymously()),
    startUpgrade: (email) => unwrap(auth.updateUser({ email })),
    finishUpgrade: (email, token) => unwrap(auth.verifyOtp({ email, token, type: 'email_change' })),
    signOut: () => unwrap(auth.signOut()),
  };
}

/**
 * FAKE MODE: no backend configured. An in-memory stand-in so the sign-in
 * screens run in local dev and CI with zero credentials: any well-formed code
 * is accepted and nothing is persisted, so every app launch starts signed out.
 */
export function fakeAuthBackend(): AuthBackend {
  let account: Account | null = null;
  let pendingUpgrade: string | null = null;
  const listeners = new Set<(account: Account | null) => void>();
  const set = (next: Account | null) => {
    account = next;
    listeners.forEach((listener) => listener(next));
  };
  return {
    getAccount: async () => account,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async sendCode() {},
    async verifyCode(email) {
      set({ userId: `fake-member-${email}`, kind: 'member', email });
    },
    async continueAsGuest() {
      set({ userId: 'fake-guest', kind: 'guest', email: null });
    },
    async startUpgrade(email) {
      pendingUpgrade = email;
    },
    async finishUpgrade(email) {
      if (!account || pendingUpgrade !== email) {
        throw new AuthError('ERR_AUTH_CODE');
      }
      pendingUpgrade = null;
      set({ ...account, kind: 'member', email });
    },
    async signOut() {
      set(null);
    },
  };
}

let backend: AuthBackend | null = null;

export function getAuthBackend(): AuthBackend {
  backend ??= hasSupabaseConfig()
    ? supabaseAuthBackend(getSupabaseClient().auth)
    : fakeAuthBackend();
  return backend;
}

export const IS_FAKE_AUTH = !hasSupabaseConfig();
