'use client';

import Link from 'next/link';

import styles from './prose.module.css';
import { SitePage } from './site-chrome';

/** Any public page that throws while rendering lands here. */
export default function SiteError({ reset }: { error: Error; reset: () => void }) {
  return (
    <SitePage>
      <article className={styles.article} role="alert">
        <p className={`${styles.kicker} ${styles.failed}`}>Something failed</p>
        <h1 className={styles.title}>This page did not load.</h1>
        <p className={styles.lede}>
          Loading this page failed. Try again, or come back in a minute.
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.action} onClick={reset}>
            Try again
          </button>
          <Link href="/" className={styles.textAction}>
            Back to the home page
          </Link>
        </div>
      </article>
    </SitePage>
  );
}
