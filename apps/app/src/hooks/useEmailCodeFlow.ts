import { useCallback, useEffect, useRef, useState } from 'react';

import {
  asAuthError,
  AuthError,
  getAuthBackend,
  normalizeCode,
  normalizeEmail,
  type AuthBackend,
} from '../lib/auth';

/** sign_in: email code that signs in or creates the account. upgrade: attach
 * an email to the current guest so its scans and orders carry over. */
export type EmailCodeMode = 'sign_in' | 'upgrade';

/** Mirrors supabase/config.toml [auth.email] max_frequency = "60s". */
export const RESEND_COOLDOWN_MS = 60_000;
/** Mirrors supabase/config.toml [auth.email] otp_expiry = 900. */
export const CODE_LIFETIME_MINUTES = 15;

export interface EmailCodeState {
  step: 'email' | 'code';
  /** Normalized address the code was sent to; set on the code step. */
  email: string | null;
  /** Upgrade mode only: the email already has an account, so the code signs
   * in to it and the guest's scans move there (mergeGuestInto). */
  merge: boolean;
  busy: boolean;
  error: AuthError | null;
  /** True after a successful resend, until the next request. */
  resent: boolean;
  /** Clock time of the last successful send; drives the resend cooldown. */
  sentAt: number | null;
}

export const INITIAL_EMAIL_CODE_STATE: EmailCodeState = {
  step: 'email',
  email: null,
  merge: false,
  busy: false,
  error: null,
  resent: false,
  sentAt: null,
};

/**
 * email -> code -> (signed in | upgraded). Success is not a state here: the
 * backend's auth change re-renders the app via AccountProvider. Input is
 * validated before any call, so a typo never spends a rate-limited send.
 */
export class EmailCodeFlow {
  private state = INITIAL_EMAIL_CODE_STATE;

  constructor(
    private readonly backend: AuthBackend,
    private readonly mode: EmailCodeMode,
    private readonly onChange: (state: EmailCodeState) => void,
    private readonly now: () => number = Date.now,
  ) {}

  getState(): EmailCodeState {
    return this.state;
  }

  /** Whole seconds until "Send a new code" is allowed again; 0 when it is. */
  resendWaitSeconds(): number {
    const { sentAt } = this.state;
    if (sentAt === null) {
      return 0;
    }
    return Math.max(0, Math.ceil((sentAt + RESEND_COOLDOWN_MS - this.now()) / 1000));
  }

  async submitEmail(input: string): Promise<void> {
    const email = normalizeEmail(input);
    if (!email) {
      this.patch({ error: new AuthError('ERR_AUTH_EMAIL') });
      return;
    }
    await this.run(async () => {
      const merge = await this.send(email);
      this.patch({ step: 'code', email, merge, sentAt: this.now() });
    });
  }

  async submitCode(input: string): Promise<void> {
    const code = normalizeCode(input);
    const { email } = this.state;
    if (!code || !email) {
      this.patch({ error: new AuthError('ERR_AUTH_CODE') });
      return;
    }
    await this.run(() => {
      if (this.mode === 'sign_in') {
        return this.backend.verifyCode(email, code);
      }
      return this.state.merge
        ? this.backend.mergeGuestInto(email, code)
        : this.backend.finishUpgrade(email, code);
    });
  }

  /** Send a fresh code to the same address, once the cooldown has passed. */
  async resend(): Promise<void> {
    const { email, merge } = this.state;
    if (!email || this.resendWaitSeconds() > 0) {
      return;
    }
    await this.run(async () => {
      let nextMerge = merge;
      if (merge) {
        await this.backend.startMerge(email);
      } else {
        nextMerge = await this.send(email);
      }
      this.patch({ merge: nextMerge, resent: true, sentAt: this.now() });
    });
  }

  /** Back to the email step ("use a different email"). */
  reset(): void {
    this.patch(INITIAL_EMAIL_CODE_STATE);
  }

  /** Returns true when the upgrade turned into a merge. */
  private async send(email: string): Promise<boolean> {
    if (this.mode === 'sign_in') {
      await this.backend.sendCode(email);
      return false;
    }
    try {
      await this.backend.startUpgrade(email);
      return false;
    } catch (error) {
      if (asAuthError(error).code !== 'ERR_AUTH_EMAIL_TAKEN') {
        throw error;
      }
      await this.backend.startMerge(email);
      return true;
    }
  }

  private async run(work: () => Promise<void>): Promise<void> {
    if (this.state.busy) {
      return;
    }
    this.patch({ busy: true, error: null, resent: false });
    try {
      await work();
      this.patch({ busy: false });
    } catch (error) {
      this.patch({ busy: false, error: asAuthError(error) });
    }
  }

  private patch(partial: Partial<EmailCodeState>): void {
    this.state = { ...this.state, ...partial };
    this.onChange(this.state);
  }
}

export function useEmailCodeFlow(mode: EmailCodeMode) {
  const [state, setState] = useState(INITIAL_EMAIL_CODE_STATE);
  const flow = useRef<EmailCodeFlow | null>(null);
  flow.current ??= new EmailCodeFlow(getAuthBackend(), mode, setState);
  const current = flow.current;
  const resendWait = current.resendWaitSeconds();
  // Re-render once a second while the countdown is visible.
  const [, tick] = useState(0);
  useEffect(() => {
    if (resendWait > 0) {
      const timer = setTimeout(() => tick((n) => n + 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [resendWait, state.sentAt]);
  return {
    state,
    resendWait,
    submitEmail: (email: string) => void current.submitEmail(email),
    submitCode: (code: string) => void current.submitCode(code),
    resend: () => void current.resend(),
    reset: () => current.reset(),
  };
}

/** Busy and typed-error state for a one-shot auth call (guest sign-in, sign-out). */
export function useAuthAction(action: (backend: AuthBackend) => Promise<void>) {
  const [state, setState] = useState<{ busy: boolean; error: AuthError | null }>({
    busy: false,
    error: null,
  });
  const run = useCallback(() => {
    setState({ busy: true, error: null });
    action(getAuthBackend()).then(
      () => setState({ busy: false, error: null }),
      (error: unknown) => setState({ busy: false, error: asAuthError(error) }),
    );
    // The action is a stable module-level arrow at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { ...state, run };
}
