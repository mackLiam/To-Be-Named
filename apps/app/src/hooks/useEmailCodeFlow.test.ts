import { describe, expect, it, vi } from 'vitest';

import { fakeAuthBackend, type AuthBackend, type FakeAuthOptions } from '../lib/auth';
import { EmailCodeFlow, RESEND_COOLDOWN_MS, type EmailCodeMode } from './useEmailCodeFlow';

function setup(
  mode: EmailCodeMode,
  overrides: Partial<AuthBackend> = {},
  options: FakeAuthOptions = {},
) {
  const backend = { ...fakeAuthBackend(options), ...overrides };
  const clock = { now: 1_000_000 };
  const flow = new EmailCodeFlow(
    backend,
    mode,
    () => {},
    () => clock.now,
  );
  /** Move the injected clock past the resend cooldown. */
  const pastCooldown = () => (clock.now += RESEND_COOLDOWN_MS);
  return { backend, flow, clock, pastCooldown };
}

describe('EmailCodeFlow', () => {
  it('does not report a resend that failed', async () => {
    let fail = false;
    const { flow, pastCooldown } = setup('sign_in', {
      sendCode: async () => {
        if (fail) throw { code: 'over_email_send_rate_limit' };
      },
    });
    await flow.submitEmail('a@b.co');
    fail = true;
    pastCooldown();
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
    const { flow, pastCooldown } = setup('sign_in', { sendCode });
    await flow.submitEmail('a@b.co');
    pastCooldown();
    await flow.resend();
    expect(sendCode).toHaveBeenNthCalledWith(2, 'a@b.co');
    expect(flow.getState().resent).toBe(true);
    flow.reset();
    expect(flow.getState()).toMatchObject({ step: 'email', email: null });
  });

  it('holds resend for 60 seconds after each send, counting down', async () => {
    const sendCode = vi.fn(async () => {});
    const { flow, clock } = setup('sign_in', { sendCode });
    expect(flow.resendWaitSeconds()).toBe(0);
    await flow.submitEmail('a@b.co');
    expect(flow.resendWaitSeconds()).toBe(60);
    clock.now += 18_500;
    expect(flow.resendWaitSeconds()).toBe(42);

    await flow.resend();
    expect(sendCode).toHaveBeenCalledTimes(1);
    expect(flow.getState().resent).toBe(false);

    clock.now += 41_500;
    expect(flow.resendWaitSeconds()).toBe(0);
    await flow.resend();
    expect(sendCode).toHaveBeenCalledTimes(2);
    // The cooldown restarts from the new send.
    expect(flow.resendWaitSeconds()).toBe(60);
  });

  it('does not start a cooldown when the send failed', async () => {
    const { flow } = setup('sign_in', {
      sendCode: async () => {
        throw { code: 'over_email_send_rate_limit' };
      },
    });
    await flow.submitEmail('a@b.co');
    expect(flow.resendWaitSeconds()).toBe(0);
  });

  describe('upgrade to an email that already has an account', () => {
    it('switches to a merge, sends a sign-in code, and moves the guest on verify', async () => {
      const startMerge = vi.fn(async () => {});
      const { backend, flow } = setup('upgrade', { startMerge }, { existingEmails: ['a@b.co'] });
      await backend.continueAsGuest();
      await flow.submitEmail('a@b.co');
      expect(startMerge).toHaveBeenCalledWith('a@b.co');
      expect(flow.getState()).toMatchObject({ step: 'code', merge: true, error: null });

      await flow.submitCode('123456');
      expect(await backend.getAccount()).toEqual({
        userId: 'fake-member-a@b.co',
        kind: 'member',
        email: 'a@b.co',
      });
    });

    it('resends a merge code without retrying the upgrade', async () => {
      const startUpgrade = vi.fn(async () => {
        throw { code: 'email_exists' };
      });
      const startMerge = vi.fn(async () => {});
      const { flow, pastCooldown } = setup('upgrade', { startUpgrade, startMerge });
      await flow.submitEmail('a@b.co');
      pastCooldown();
      await flow.resend();
      expect(startUpgrade).toHaveBeenCalledTimes(1);
      expect(startMerge).toHaveBeenCalledTimes(2);
    });

    it('shows the merge error, keeps the guest, and lets the user retry', async () => {
      const fail: FakeAuthOptions['fail'] = { claim_transfer: { code: '22023' } };
      const { backend, flow } = setup('upgrade', {}, { existingEmails: ['a@b.co'], fail });
      await backend.continueAsGuest();
      const guest = await backend.getAccount();
      await flow.submitEmail('a@b.co');
      await flow.submitCode('123456');
      expect(flow.getState()).toMatchObject({
        step: 'code',
        busy: false,
        error: { code: 'ERR_AUTH_TRANSFER' },
      });
      expect(await backend.getAccount()).toEqual(guest);

      delete fail.claim_transfer;
      await flow.submitCode('123456');
      expect((await backend.getAccount())?.kind).toBe('member');
    });

    it('surfaces a failed merge send instead of the email-taken error', async () => {
      const { flow } = setup(
        'upgrade',
        {
          startMerge: async () => {
            throw { code: 'over_email_send_rate_limit' };
          },
        },
        { existingEmails: ['a@b.co'] },
      );
      await flow.submitEmail('a@b.co');
      expect(flow.getState()).toMatchObject({
        step: 'email',
        merge: false,
        error: { code: 'ERR_AUTH_RATE_LIMIT' },
      });
    });
  });
});
