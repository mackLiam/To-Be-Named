'use client';

import styles from '../admin.module.css';

/** A failed search (for example the lookup function is missing) renders here. */
export default function CustomersError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className={styles.main}>
      <div className={styles.errorState} role="alert">
        <p className={styles.formError}>The customer search failed. Nothing was changed.</p>
        <button type="button" className={styles.secondaryBtn} onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
