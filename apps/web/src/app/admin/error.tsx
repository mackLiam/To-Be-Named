'use client';

import Link from 'next/link';

import styles from './admin.module.css';

/** An admin page that throws (a failed read, a missing function) lands here. */
export default function AdminError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className={styles.main}>
      <div className={styles.errorState} role="alert">
        <p className={styles.formError}>This page failed to load. Nothing was changed.</p>
        <div className={styles.actionBar}>
          <button type="button" className={styles.secondaryBtn} onClick={reset}>
            Try again
          </button>
          <Link href="/admin/orders" className={styles.backLink}>
            Back to orders
          </Link>
        </div>
      </div>
    </main>
  );
}
