'use client';

import { useFormStatus } from 'react-dom';

import { Spinner } from '../Spinner';
import styles from './admin.module.css';

/**
 * Submit button that shows the pending state of its form's server action and
 * blocks a second submit while it runs. Busy keeps full color and adds a
 * spinner; only a truly unavailable button gets the flat disabled block.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant = 'primary',
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: 'primary' | 'secondary';
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className={variant === 'primary' ? styles.primaryBtn : styles.secondaryBtn}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? (
        <>
          <Spinner />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}
