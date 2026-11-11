'use client';

import { useFormStatus } from 'react-dom';

import styles from './admin.module.css';

/**
 * Submit button that shows the pending state of its form's server action and
 * blocks a second submit while it runs.
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
      className={variant === 'primary' ? styles.downloadBtn : styles.secondaryBtn}
      disabled={pending}
      aria-disabled={pending}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
