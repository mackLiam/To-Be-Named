import { describe, expect, it, vi } from 'vitest';

import { fakeAuthBackend, type AuthBackend } from '../lib/auth';
import { EmailCodeFlow, type EmailCodeMode } from './useEmailCodeFlow';

function setup(mode: EmailCodeMode, overrides: Partial<AuthBackend> = {}) {
  const backend = { ...fakeAuthBackend(), ...overrides };
  const flow = new EmailCodeFlow(backend, mode, () => {});
  return { backend, flow };
}

describe('EmailCodeFlow', () => {
  it('does not report a resend that failed', async () => {
    let fail = false;
    const { flow } = setup('sign_in', {
      sendCode: async () => {
        if (fail) throw { code: 'over_email_send_rate_limit' };
      },
    });
    await flow.submitEmail('a@b.co');
    fail = true;
    await flow.resend();
    expect(flow.getState()).toMatchObject({
      resent: false,
      error: { code: 'ERR_AUTH_RATE_LIMIT' },
    });
  });

  it('signs in: email then code, normalizing both', async () => {
    const { backend, flow } = setup('sign_in');
    await flow.submitEmail(' A@B.co ');
    expect(flow.getState()).toMatchObject({ step: 'code', email: 'a@b.co', error: null });
    await flow.submitCode('123 456');
    expect(await backend.getAccount()).toMatchObject({ kind: 'member', email: 'a@b.co' });
  });

  it('rejects a bad email without calling the backend', async () => {
    const sendCode = vi.fn(async () => {});
    const { flow } = setup('sign_in', { sendCode });
    await flow.submitEmail('nope');
    expect(sendCode).not.toHaveBeenCalled();
    expect(flow.getState()).toMatchObject({ step: 'email', error: { code: 'ERR_AUTH_EMAIL' } });
  });

  it('rejects a malformed code without calling the backend', async () => {
    const verifyCode = vi.fn(async () => {});
    const { flow } = setup('sign_in', { verifyCode });
    await flow.submitEmail('a@b.co');
    await flow.submitCode('12');
    expect(verifyCode).not.toHaveBeenCalled();
    expect(flow.getState().error?.code).toBe('ERR_AUTH_CODE');
  });

  it('surfaces a typed backend error and stays on the step', async () => {
    const { flow } = setup('sign_in', {
      sendCode: async () => {
        throw { code: 'over_email_send_rate_limit' };
      },
    });
    await flow.submitEmail('a@b.co');
    expect(flow.getState()).toMatchObject({
      step: 'email',
      busy: false,
      error: { code: 'ERR_AUTH_RATE_LIMIT' },
    });
  });

  it('upgrades a guest in place, keeping the user id', async () => {
    const { backend, flow } = setup('upgrade');
    await backend.continueAsGuest();
    const guestId = (await backend.getAccount())?.userId;
    await flow.submitEmail('a@b.co');
    await flow.submitCode('123456');
    expect(await backend.getAccount()).toEqual({
      userId: guestId,
      kind: 'member',
      email: 'a@b.co',
    });
  });

  it('ignores a second submit while one is in flight', async () => {
    let release = () => {};
    const sendCode = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { flow } = setup('sign_in', { sendCode });
    const first = flow.submitEmail('a@b.co');
    await flow.submitEmail('a@b.co');
    release();
    await first;
    expect(sendCode).toHaveBeenCalledTimes(1);
  });

  it('resend re-sends to the same address; reset returns to the email step', async () => {
    const sendCode = vi.fn(async () => {});
    const { flow } = setup('sign_in', { sendCode });
    await flow.submitEmail('a@b.co');
    await flow.resend();
    expect(sendCode).toHaveBeenNthCalledWith(2, 'a@b.co');
    expect(flow.getState().resent).toBe(true);
    flow.reset();
    expect(flow.getState()).toMatchObject({ step: 'email', email: null });
  });
});
