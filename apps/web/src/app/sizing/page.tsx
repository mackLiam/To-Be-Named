import type { Metadata } from 'next';
import Link from 'next/link';

import { BRAND_NAME, SUPPORT_EMAIL } from '@forms/shared/brand';

import { pageMetadata } from '@/lib/seo';

import styles from '../prose.module.css';
import { SitePage } from '../site-chrome';

export const metadata: Metadata = pageMetadata({
  title: `Sizing - ${BRAND_NAME}`,
  description: `How ${BRAND_NAME} measures your leg so the guard is made to fit it.`,
  path: '/sizing',
  siteName: BRAND_NAME,
});

const mail = <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>;
const pending = <span className={styles.placeholder}>This answer is coming before launch.</span>;

// Facts on this page come only from existing sources: the scan requirement is
// support/page.tsx; the by-hand route is apps/app/app/capture.tsx; the four
// measurement heights (20, 40, 60 and 80 percent of leg length, up from the
// ankle) are CLAUDE.md gotcha 2 and docs/DESIGN.md (the 25-variable schema).
// Sizes, tolerances and kid-specific advice are not decided and stay
// placeholders.

export default function SizingPage() {
  return (
    <SitePage>
      <article className={styles.article}>
        <p className={styles.kicker}>Sizing</p>
        <h1 className={styles.title}>Made to your leg.</h1>
        <p className={styles.lede}>
          There is no size chart to pick from. Your guard is printed from a scan of your leg.
        </p>

        <div className={styles.body}>
          <section>
            <h2>How we measure</h2>
            <p>
              Scan your leg with any iPhone on iOS 17 or later, or measure by hand and enter the
              numbers in the app. Either way, the guard is printed from your measurements.
            </p>
          </section>

          <section>
            <h2>Where on your leg</h2>
            <p>
              We take your leg length, from the bottom of the ankle to the knee, then measure the
              shape of your leg at four heights above the ankle:
            </p>
            <ul>
              <li>20 percent of your leg length</li>
              <li>40 percent of your leg length</li>
              <li>60 percent of your leg length</li>
              <li>80 percent of your leg length</li>
            </ul>
          </section>

          <section>
            <h2>Getting a good scan</h2>
            {/* TODO(liam): write scan tips (clothing, lighting, posture) from real capture trials. */}
            <p>{pending}</p>
            <p>
              If a scan cannot be measured reliably, the app asks you to scan again. Trouble
              scanning: see <Link href="/support">Support</Link>.
            </p>
          </section>

          <section>
            <h2>Growing kids</h2>
            {/* TODO(liam): decide the advice and policy for growing kids (when to rescan, remake eligibility). */}
            <p>{pending}</p>
          </section>

          <section>
            <h2>Left and right legs</h2>
            {/* TODO(liam): confirm whether to say legs are measured and printed separately, and pair pricing. */}
            <p>{pending}</p>
          </section>

          <section>
            <h2>If it does not fit</h2>
            <p>
              Email {mail}. See <Link href="/returns">Returns</Link> for how fit problems are
              handled.
            </p>
          </section>
        </div>
      </article>
    </SitePage>
  );
}
