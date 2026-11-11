import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME, SUPPORT_EMAIL } from '@forms/shared/brand';

import { pageMetadata } from '@/lib/seo';

import styles from '../prose.module.css';
import { SitePage } from '../site-chrome';

export const metadata: Metadata = pageMetadata({
  title: `Returns - ${BRAND_NAME}`,
  description: `Cancellations, fit problems and refunds for ${BRAND_NAME} made-to-order shin guards.`,
  path: '/returns',
  siteName: BRAND_NAME,
});

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;
const pending = <span className={styles.placeholder}>This answer is coming before launch.</span>;

// Facts on this page come only from terms/page.tsx (made to order; cancel
// until production starts; fit handled case by case with a rescan and reprint
// or a refund) and support/page.tsx (what to include). The returns window,
// remake rule and return shipping are not decided and stay placeholders.

export default function ReturnsPage() {
  return (
    <SitePage>
      <article className={styles.article}>
        <p className={styles.kicker}>Returns</p>
        <h1 className={styles.title}>If something is wrong.</h1>
        <p className={styles.lede}>
          Each guard is made to order for one person. Here is what happens if you need to cancel or
          it does not fit.
        </p>

        <div className={styles.body}>
          <section>
            <h2>Cancelling an order</h2>
            <p>
              Because each guard is made to order, you can cancel until production starts. Email{' '}
              {mail} with your order reference.
            </p>
          </section>

          <section>
            <h2>If your guard does not fit</h2>
            <p>
              Contact {mail}. We handle fit problems case by case: we may ask you to rescan and
              reprint the guard, or refund you.
            </p>
            <h3>What to include</h3>
            <ul>
              <li>Your order reference, from the Orders tab in the app.</li>
              <li>The email address on your account.</li>
              <li>What went wrong, in as much detail as you can.</li>
            </ul>
          </section>

          <section>
            <h2>Returns window</h2>
            {/* TODO(liam): decide the returns window and whether made-to-order guards are returnable. */}
            <p>{pending}</p>
          </section>

          <section>
            <h2>Remakes</h2>
            {/* TODO(liam): decide the remake versus refund rule and whether a fit remake needs a rescan first. */}
            <p>{pending}</p>
          </section>

          <section>
            <h2>Return shipping</h2>
            {/* TODO(liam): decide who pays return shipping and whether the guard must be sent back. */}
            <p>{pending}</p>
          </section>

          <section>
            <h2>Refunds</h2>
            {/* TODO(liam): decide refund timing and method wording. */}
            <p>{pending}</p>
            <p>
              The legal terms are in the <Link href="/terms">terms</Link>. Other help:{' '}
              <Link href="/support">Support</Link>.
            </p>
          </section>
        </div>
      </article>
    </SitePage>
  );
}
