'use client';

import styles from '../admin.module.css';

/** A failed search (for example the lookup function is missing) renders here. */
export default function CustomersError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className={styles.main}>
      <p className={styles.formError} role="alert">
        The customer search failed. Nothing was changed.
      </p>
      <button type="button" className={styles.secondaryBtn} onClick={reset}>
        Try again
      </button>
    </main>
  );
}
