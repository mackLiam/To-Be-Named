import { useCallback, useRef, useState } from 'react';

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

export interface EmailCodeState {
  step: 'email' | 'code';
  /** Normalized address the code was sent to; set on the code step. */
  email: string | null;
  busy: boolean;
  error: AuthError | null;
  /** True after a successful resend, until the next request. */
  resent: boolean;
}

export const INITIAL_EMAIL_CODE_STATE: EmailCodeState = {
  step: 'email',
  email: null,
  busy: false,
  error: null,
  resent: false,
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
  ) {}

  getState(): EmailCodeState {
    return this.state;
  }

  async submitEmail(input: string): Promise<void> {
    const email = normalizeEmail(input);
    if (!email) {
      this.patch({ error: new AuthError('ERR_AUTH_EMAIL') });
      return;
    }
    await this.run(async () => {
      await (this.mode === 'sign_in'
        ? this.backend.sendCode(email)
        : this.backend.startUpgrade(email));
      this.patch({ step: 'code', email });
    });
  }

  async submitCode(input: string): Promise<void> {
    const code = normalizeCode(input);
    const { email } = this.state;
    if (!code || !email) {
      this.patch({ error: new AuthError('ERR_AUTH_CODE') });
      return;
    }
    await this.run(() =>
      this.mode === 'sign_in'
        ? this.backend.verifyCode(email, code)
        : this.backend.finishUpgrade(email, code),
    );
  }

  /** Send a fresh code to the same address. */
  async resend(): Promise<void> {
    if (this.state.email) {
      await this.submitEmail(this.state.email);
      if (!this.state.error) {
        this.patch({ resent: true });
      }
    }
  }

  /** Back to the email step ("use a different email"). */
  reset(): void {
    this.patch(INITIAL_EMAIL_CODE_STATE);
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
  return {
    state,
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
