/**
 * Waitlist sign-up rules. Pure, so the server action stays a thin shell.
 * Bounds and the shape check mirror the public.waitlist CHECK constraints in
 * supabase/migrations/0013_orders_checkout.sql; change both together.
 */

export const WAITLIST_INTERESTS = ['launch', 'pro', 'junior_max'] as const;
export type WaitlistInterest = (typeof WAITLIST_INTERESTS)[number];

export type WaitlistState =
  | { status: 'idle' }
  | { status: 'ok'; message: string }
  | { status: 'closed'; message: string }
  | { status: 'error'; message: string };

export type ParsedWaitlist =
  | { kind: 'ok'; email: string; interest: WaitlistInterest }
  | { kind: 'honeypot' }
  | { kind: 'invalid'; message: string };

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const OK_STATE: WaitlistState = {
  status: 'ok',
  message: 'You are on the list. We will email you when it is ready.',
};
export const CLOSED_STATE: WaitlistState = {
  status: 'closed',
  message: 'Sign-ups open soon. Check back in a few days.',
};
export const FAILED_STATE: WaitlistState = {
  status: 'error',
  message: 'Sign-up failed on our side. Try again in a minute.',
};

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseWaitlistInput(input: {
  email: unknown;
  interest: unknown;
  honeypot: unknown;
}): ParsedWaitlist {
  if (str(input.honeypot).trim() !== '') return { kind: 'honeypot' };

  const interest = str(input.interest);
  if (!(WAITLIST_INTERESTS as readonly string[]).includes(interest)) {
    return { kind: 'invalid', message: 'That sign-up option is not available.' };
  }

  const email = str(input.email).trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !EMAIL_SHAPE.test(email)) {
    return { kind: 'invalid', message: 'Enter a valid email address, like name@example.com.' };
  }
  return { kind: 'ok', email, interest: interest as WaitlistInterest };
}

/** A duplicate is success, so the form never reveals who is already on the list. */
export function insertResultToState(error: { code?: string } | null): WaitlistState {
  if (!error || error.code === '23505') return OK_STATE;
  return FAILED_STATE;
}
