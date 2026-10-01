import type { Metadata } from 'next';

import { BRAND_NAME, SUPPORT_EMAIL } from '@forms/shared/brand';

import styles from '../prose.module.css';
import { SiteFooter, SiteHeader } from '../site-chrome';

export const metadata: Metadata = {
  title: `Support - ${BRAND_NAME}`,
  description: `Help with scanning, orders and fit for ${BRAND_NAME} shin guards.`,
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;

export default function SupportPage() {
  return (
    <main className={styles.main}>
      <SiteHeader />
      <article className={styles.article}>
        <p className={styles.kicker}>Support</p>
        <h1 className={styles.title}>Get help.</h1>
        <p className={styles.lede}>
          Scan not working, order question, guard not fitting: email {mail} and tell us what
          happened.
        </p>

        <div className={styles.body}>
          <section>
            <h2>What we can help with</h2>
            <h3>Scan trouble</h3>
            <p>
              The app will not finish a scan, or asks you to rescan. Tell us your iPhone model and
              which step it stopped on.
            </p>
            <h3>Order questions</h3>
            <p>Payment, shipping, or cancelling an order before production starts.</p>
            <h3>Fit issues</h3>
            <p>
              Your guard pinches, slips or does not sit right. We handle fit problems case by case,
              with a rescan and reprint or a refund.
            </p>
          </section>

          <section>
            <h2>What to include</h2>
            <ul>
              <li>
                <strong>Your order reference</strong>, from the Orders tab in the app.
              </li>
              <li>The email address on your account.</li>
              <li>What went wrong, in as much detail as you can.</li>
            </ul>
          </section>

          <section>
            <h2>Device requirements</h2>
            <ul>
              <li>
                <strong>Fastest:</strong> iPhone 12 Pro or a later Pro model with LiDAR, on iOS 17
                or later.
              </li>
              <li>
                <strong>Other iPhones</strong> use the guided photo capture instead. It works, but
                it takes longer.
              </li>
            </ul>
          </section>

          <section>
            <h2>Email</h2>
            <p>{mail}</p>
          </section>
        </div>
      </article>
      <SiteFooter />
    </main>
  );
}
