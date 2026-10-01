import { describe, expect, it } from 'vitest';

import { FAILED_STATE, OK_STATE, insertResultToState, parseWaitlistInput } from './waitlist';

const base = { email: 'player@example.com', interest: 'launch', honeypot: '' };

describe('parseWaitlistInput', () => {
  it('accepts a good email, trimmed and lowercased', () => {
    expect(parseWaitlistInput({ ...base, email: '  Player@Example.COM ' })).toEqual({
      kind: 'ok',
      email: 'player@example.com',
      interest: 'launch',
    });
  });

  it('accepts every allowlisted interest', () => {
    for (const interest of ['launch', 'pro', 'junior_max']) {
      expect(parseWaitlistInput({ ...base, interest }).kind).toBe('ok');
    }
  });

  it.each(['', 'player', 'player@example', '@example.com', 'a b@example.com', 'a@@b.com'])(
    'rejects bad shape %j',
    (email) => {
      expect(parseWaitlistInput({ ...base, email }).kind).toBe('invalid');
    },
  );

  it('rejects an email over 320 characters', () => {
    const email = `${'a'.repeat(310)}@example.com`;
    expect(email.length).toBeGreaterThan(320);
    expect(parseWaitlistInput({ ...base, email }).kind).toBe('invalid');
  });

  it('accepts an email of exactly 320 characters', () => {
    const email = `${'a'.repeat(308)}@example.com`;
    expect(email.length).toBe(320);
    expect(parseWaitlistInput({ ...base, email }).kind).toBe('ok');
  });

  it.each(['', 'club', 'LAUNCH', 'junior-max', null, 7])(
    'rejects unknown interest %j',
    (interest) => {
      expect(parseWaitlistInput({ ...base, interest }).kind).toBe('invalid');
    },
  );

  it('rejects non-string email input', () => {
    expect(parseWaitlistInput({ ...base, email: null }).kind).toBe('invalid');
  });

  it('flags a filled honeypot before any other check', () => {
    expect(parseWaitlistInput({ email: 'bad', interest: 'nope', honeypot: 'http://spam' })).toEqual(
      { kind: 'honeypot' },
    );
  });

  it('treats a whitespace-only honeypot as empty', () => {
    expect(parseWaitlistInput({ ...base, honeypot: '   ' }).kind).toBe('ok');
  });
});

describe('insertResultToState', () => {
  it('maps no error to success', () => {
    expect(insertResultToState(null)).toEqual(OK_STATE);
  });

  it('maps a duplicate (23505) to success', () => {
    expect(insertResultToState({ code: '23505' })).toEqual(OK_STATE);
  });

  it('maps any other error to a failure', () => {
    expect(insertResultToState({ code: '23514' })).toEqual(FAILED_STATE);
    expect(insertResultToState({})).toEqual(FAILED_STATE);
  });
});
