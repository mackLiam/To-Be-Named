import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../../prose.module.css';
import { SitePage } from '../../site-chrome';

// Static by design: the ?order= id is untrusted and never read or shown.
export const metadata: Metadata = {
  title: `Checkout cancelled - ${BRAND_NAME}`,
  robots: { index: false, follow: false },
};

export default function CheckoutCancelledPage() {
  return (
    <SitePage>
      <article className={styles.article}>
        <p className={styles.kicker}>Checkout cancelled</p>
        <h1 className={styles.title}>No charge was made.</h1>
        <p className={styles.lede}>
          Your payment was not taken. You can start the order again from the Shop in the{' '}
          {BRAND_NAME} app whenever you are ready.
        </p>
        <div className={styles.actions}>
          <a href="zells://shop" className={styles.action}>
            Open the app
          </a>
          <Link href="/support" className={styles.textAction}>
            Get help
          </Link>
        </div>
      </article>
    </SitePage>
  );
}
