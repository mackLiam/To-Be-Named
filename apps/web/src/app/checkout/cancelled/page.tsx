import type { Metadata } from 'next';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../../page.module.css';

// Static by design: the ?order= id is untrusted and never read or shown.
export const metadata: Metadata = {
  title: `Checkout cancelled - ${BRAND_NAME}`,
  robots: { index: false, follow: false },
};

export default function CheckoutCancelledPage() {
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
          <p className={styles.kicker}>Checkout cancelled</p>
          <h1 className={styles.headline}>
            No charge <span className={styles.accent}>was made.</span>
          </h1>
          <p className={styles.subhead}>
            Your payment was not taken. You can start the order again from the Shop in the{' '}
            {BRAND_NAME} app whenever you are ready.
          </p>
        </div>
      </section>
    </main>
  );
}
