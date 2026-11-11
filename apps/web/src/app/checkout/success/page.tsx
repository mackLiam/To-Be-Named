import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../../prose.module.css';
import { SitePage } from '../../site-chrome';

// Static by design: the ?order= id is untrusted and never read or shown.
export const metadata: Metadata = {
  title: `Payment received - ${BRAND_NAME}`,
  robots: { index: false, follow: false },
};

export default function CheckoutSuccessPage() {
  return (
    <SitePage>
      <article className={styles.article}>
        <p className={styles.kicker}>Checkout complete</p>
        <h1 className={styles.title}>Payment received.</h1>
        <p className={styles.lede}>
          Thanks for your order. It now appears in the Orders tab of the {BRAND_NAME} app, where you
          can follow it from printing to delivery.
        </p>
        <div className={styles.actions}>
          <a href="zells://orders" className={styles.action}>
            Open the app
          </a>
          <Link href="/support" className={styles.textAction}>
            Questions about your order
          </Link>
        </div>
      </article>
    </SitePage>
  );
}
