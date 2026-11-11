'use client';

import { useActionState, useId } from 'react';

import type { WaitlistInterest, WaitlistState } from '@/lib/waitlist';

import { Spinner } from './Spinner';
import styles from './waitlist.module.css';
import { joinWaitlist } from './waitlist-action';

const initial: WaitlistState = { status: 'idle' };

export function WaitlistForm({
  interest,
  label,
  button = 'Notify me',
}: {
  interest: WaitlistInterest;
  label: string;
  button?: string;
}) {
  const [state, action, pending] = useActionState(joinWaitlist, initial);
  const id = useId();
  const isError = state.status === 'error';

  if (state.status === 'ok') {
    return (
      <p className={styles.done} role="status">
        {state.message}
      </p>
    );
  }

  return (
    <form action={action} className={styles.form} noValidate aria-busy={pending}>
      <input type="hidden" name="interest" value={interest} />
      {/* Honeypot: hidden from people and assistive tech, bots fill it. */}
      <div className={styles.trap} aria-hidden="true">
        <label htmlFor={`${id}-website`}>Website</label>
        <input id={`${id}-website`} name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <label htmlFor={`${id}-email`} className={styles.label}>
        {label}
      </label>
      <div className={styles.row}>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          maxLength={320}
          placeholder="you@example.com"
          aria-invalid={isError || undefined}
          aria-describedby={`${id}-msg`}
          className={styles.input}
        />
        {/* Busy, not unavailable: full color plus a spinner. `disabled` only
            blocks a second submit; the CSS keeps the busy look. */}
        <button type="submit" className={styles.button} disabled={pending} aria-busy={pending}>
          {pending ? (
            <>
              <Spinner />
              Sending
            </>
          ) : (
            button
          )}
        </button>
      </div>
      <p
        id={`${id}-msg`}
        className={isError ? styles.error : styles.message}
        role="status"
        aria-live="polite"
      >
        {state.status === 'idle' ? '' : state.message}
      </p>
    </form>
  );
}
