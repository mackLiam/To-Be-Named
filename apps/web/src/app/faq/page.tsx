import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME, SUPPORT_EMAIL } from '@forms/shared/brand';

import { pageMetadata } from '@/lib/seo';

import styles from '../prose.module.css';
import { SitePage } from '../site-chrome';

export const metadata: Metadata = pageMetadata({
  title: `FAQ - ${BRAND_NAME}`,
  description: `Common questions about scanning, ordering and wearing ${BRAND_NAME} custom-fit shin guards.`,
  path: '/faq',
  siteName: BRAND_NAME,
});

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;
const pending = <span className={styles.placeholder}>This answer is coming before launch.</span>;

// Facts on this page come only from existing copy: the scan requirement is
// support/page.tsx ("Any iPhone on iOS 17 or later"); the by-hand route is the
// manual entry flow in apps/app/app/capture.tsx; "printed from your scan" and
// "scan again rather than a guess" are terms/page.tsx (Your guard, Your scan);
// the certification notice is terms/page.tsx (Protective equipment notice).
// Everything else is a placeholder awaiting a decision.

export default function FaqPage() {
  return (
    <SitePage>
      <article className={styles.article}>
        <p className={styles.kicker}>FAQ</p>
        <h1 className={styles.title}>Questions.</h1>
        <p className={styles.lede}>
          Answers about scanning and ordering. Anything not covered here, email {mail}.
        </p>

        <div className={styles.body}>
          <section>
            <h2>Scanning</h2>
            <h3>What do I need to scan my leg?</h3>
            <p>
              Any iPhone on iOS 17 or later. If you would rather not scan, you can measure by hand
              and enter the numbers in the app.
            </p>
            <h3>What if my scan cannot be measured?</h3>
            <p>
              If a scan cannot be measured reliably, the app asks you to scan again rather than
              making a guard from it.
            </p>
          </section>

          <section>
            <h2>Your guard</h2>
            <h3>How is my guard made?</h3>
            <p>
              Your guard is 3D printed to the measurements taken from your scan. It is made to order
              and is not made for anyone else.
            </p>
            <h3>What are the guards made of?</h3>
            {/* TODO(liam): decide the printed material and finish to state publicly. */}
            <p>{pending}</p>
            <h3>How do I care for my guard?</h3>
            {/* TODO(liam): write care instructions once the material and finish are chosen. */}
            <p>{pending}</p>
            <h3>Are the guards certified for league play?</h3>
            <p>
              {BRAND_NAME} guards are not certified to NOCSAE ND090 or EN 13061 at this time. Some
              leagues require certified shin guards, so check your league&apos;s equipment rules
              before you wear them in a match.
            </p>
          </section>

          <section>
            <h2>Ordering and delivery</h2>
            <h3>How long does delivery take?</h3>
            {/* TODO(liam): decide production plus shipping time to publish, from the print partner lead time. */}
            <p>{pending}</p>
            <h3>Where do you ship?</h3>
            {/* TODO(liam): decide the shipping countries and rates (also drives STRIPE_SHIPPING_COUNTRIES). */}
            <p>{pending}</p>
            <h3>Can I cancel an order?</h3>
            {/* TODO(liam): confirm the cancellation wording with the final terms. */}
            <p>
              Because each guard is made to order, you can cancel until production starts. Email{' '}
              {mail} with your order reference.
            </p>
          </section>

          <section>
            <h2>Fit, returns and sizing</h2>
            <h3>What if my guard does not fit?</h3>
            <p>
              Contact {mail}. We handle fit problems case by case, with a rescan and reprint or a
              refund. The full policy is on the <Link href="/returns">Returns</Link> page.
            </p>
            <h3>Will the guard still fit as my child grows?</h3>
            {/* TODO(liam): decide the policy and advice for growing kids (reorder timing, remake eligibility). */}
            <p>{pending}</p>
            <p>
              How the measurements work is on the <Link href="/sizing">Sizing</Link> page.
            </p>
          </section>

          <section>
            <h2>Still stuck</h2>
            <p>
              Email {mail}, or see <Link href="/support">Support</Link>.
            </p>
          </section>
        </div>
      </article>
    </SitePage>
  );
}
