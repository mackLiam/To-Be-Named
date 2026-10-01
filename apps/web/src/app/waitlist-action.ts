'use server';

import { hasServiceRoleConfig } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase-admin';
import {
  CLOSED_STATE,
  FAILED_STATE,
  OK_STATE,
  insertResultToState,
  parseWaitlistInput,
  type WaitlistState,
} from '@/lib/waitlist';

// Never log the submitted email: it is personal data, possibly a minor's.
export async function joinWaitlist(_prev: WaitlistState, form: FormData): Promise<WaitlistState> {
  const parsed = parseWaitlistInput({
    email: form.get('email'),
    interest: form.get('interest'),
    honeypot: form.get('website'),
  });
  // Bots get a success-looking answer and nothing is written.
  if (parsed.kind === 'honeypot') return OK_STATE;
  if (parsed.kind === 'invalid') return { status: 'error', message: parsed.message };
  if (!hasServiceRoleConfig()) return CLOSED_STATE;

  try {
    const { error } = await createServiceRoleClient()
      .from('waitlist')
      .insert({ email: parsed.email, interest: parsed.interest });
    if (error && error.code !== '23505') console.error('waitlist insert failed', error.code);
    return insertResultToState(error);
  } catch {
    console.error('waitlist insert threw');
    return FAILED_STATE;
  }
}
