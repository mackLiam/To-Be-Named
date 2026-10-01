import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME, SUPPORT_EMAIL } from '@forms/shared/brand';

import styles from '../prose.module.css';
import { SiteFooter, SiteHeader } from '../site-chrome';

export const metadata: Metadata = {
  title: `Terms of sale - ${BRAND_NAME}`,
  description: `The terms for buying a custom-made ${BRAND_NAME} shin guard.`,
};

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;
const legalTodo = <span className={styles.placeholder}>[to be completed with legal review]</span>;

export default function TermsPage() {
  return (
    <main className={styles.main}>
      <SiteHeader />
      <article className={styles.article}>
        <p className={styles.kicker}>Terms of sale</p>
        <h1 className={styles.title}>Made to your scan.</h1>
        <p className={styles.lede}>
          Every {BRAND_NAME} guard is printed for one leg. These terms cover what that means for
          ordering, cancelling and fit.
        </p>
        <p className={styles.notice} role="note">
          Draft. These terms are pending legal review and may change before launch.
        </p>

        <div className={styles.body}>
          <section>
            <h2>A custom-made product</h2>
            <p>
              Your guard is made to order and 3D printed to the measurements taken from your scan.
              It is not a stock item and is not made for anyone else.
            </p>
          </section>

          <section>
            <h2>Your scan</h2>
            <p>
              You are responsible for an accurate scan. Follow the guidance in the app while you
              capture. If a scan cannot be measured reliably, the app asks you to scan again rather
              than making a guard from it.
            </p>
          </section>

          <section>
            <h2>Price and payment</h2>
            <p>
              The price is shown at checkout. Payment is taken at checkout through Stripe. We never
              see or store your card number.
            </p>
          </section>

          <section>
            <h2>Shipping</h2>
            <p>We ship to the countries offered at checkout.</p>
          </section>

          <section>
            <h2>Cancellation and fit</h2>
            <p>
              Because each guard is made to order, you can cancel until production starts. Email{' '}
              {mail} with your order reference.
            </p>
            <p>
              If your guard does not fit, contact {mail}. We handle fit problems case by case: we
              may ask you to rescan and reprint the guard, or refund you.
            </p>
          </section>

          <section>
            <h2>Protective equipment notice</h2>
            <p>
              <strong>
                {BRAND_NAME} guards are not certified to NOCSAE ND090 or EN 13061 at this time.
              </strong>{' '}
              Some leagues require certified shin guards. Check your league&apos;s equipment rules
              before you wear them in a match.
            </p>
          </section>

          <section>
            <h2>Limitation of liability</h2>
            <p>{legalTodo}</p>
          </section>

          <section>
            <h2>Governing law</h2>
            <p>{legalTodo}</p>
          </section>

          <section>
            <h2>Contact</h2>
            <p>
              Email {mail}, or see <Link href="/support">Support</Link>. How we handle your data is
              in the <Link href="/privacy">privacy policy</Link>.
            </p>
          </section>
        </div>
      </article>
      <SiteFooter />
    </main>
  );
}
