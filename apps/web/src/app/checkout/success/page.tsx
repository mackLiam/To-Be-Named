import type { Metadata } from 'next';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../../page.module.css';

// Static by design: the ?order= id is untrusted and never read or shown.
export const metadata: Metadata = {
  title: `Payment received - ${BRAND_NAME}`,
  robots: { index: false, follow: false },
};

export default function CheckoutSuccessPage() {
  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static SVG wordmark, nothing to optimize */}
        <img
          src="/brand/wordmark-reverse-for-brown.svg"
          alt={BRAND_NAME}
          className={styles.wordmark}
        />
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>Checkout complete</p>
          <h1 className={styles.headline}>
            Payment <span className={styles.accent}>received.</span>
          </h1>
          <p className={styles.subhead}>
            Thanks for your order. It now appears in the Orders tab of the {BRAND_NAME} app, where
            you can follow it from printing to delivery.
          </p>
          <p className={styles.subhead}>
            <a href="zells://orders" className={styles.status}>
              Open the app
            </a>
          </p>
        </div>
      </section>
    </main>
  );
}
