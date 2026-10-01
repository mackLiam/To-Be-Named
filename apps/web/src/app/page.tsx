import type { Metadata } from 'next';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from './page.module.css';
import { SiteFooter, SiteHeader } from './site-chrome';
import { WaitlistForm } from './WaitlistForm';

export const metadata: Metadata = {
  title: `${BRAND_NAME} - shin guards molded to your leg`,
  description:
    'Custom-fit, 3D-printed soccer shin guards. Scan your leg with your iPhone, we generate the fit, we print and ship it.',
};

const steps = [
  { n: '01', title: 'Scan your leg.', line: 'About a minute per leg, on your iPhone.' },
  { n: '02', title: 'We shape the fit.', line: '25 measurements drive every curve.' },
  { n: '03', title: 'Printed and shipped.', line: 'Made for one leg, sent to your door.' },
];

// Slice lines sit at 20/40/60/80% of guard length measured up from the ankle
// tip, the same S1-S4 positions the measurement schema uses.
const GUARD_TOP = 6;
const GUARD_TIP = 413;
const slices = [0.2, 0.4, 0.6, 0.8].map((f) => GUARD_TIP - f * (GUARD_TIP - GUARD_TOP));
const SHELL =
  'M120 6C196 6 228 30 228 110C228 230 196 342 148 404C138 416 102 416 92 404C44 342 12 230 12 110C12 30 44 6 120 6Z';

function Guard() {
  return (
    <svg viewBox="0 0 240 420" className={styles.guard} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id="guard-shell">
          <path d={SHELL} />
        </clipPath>
      </defs>
      <path d={SHELL} className={styles.guardShell} />
      <g clipPath="url(#guard-shell)" className={styles.guardSlices}>
        {slices.map((y) => (
          <path key={y} d={`M0 ${y}Q120 ${y + 22} 240 ${y}`} />
        ))}
      </g>
      <rect x="113" y="40" width="14" height="330" rx="4" className={styles.guardSpine} />
    </svg>
  );
}

export default function HomePage() {
  return (
    <main className={styles.page}>
      <SiteHeader />

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <h1 className={styles.headline}>
            Shin guards molded to <span className={styles.accent}>your leg.</span>
          </h1>
          <p className={styles.subhead}>Scan with your iPhone. We print the fit.</p>
          <div className={styles.heroForm}>
            <WaitlistForm interest="launch" label="Email me when ordering opens" />
          </div>
        </div>
        <Guard />
      </section>

      <section className={styles.steps} aria-label="How it works">
        <ol className={styles.stepList}>
          {steps.map((step) => (
            <li key={step.n} className={styles.step}>
              <span className={styles.stepNum}>{step.n}</span>
              <div>
                <h2 className={styles.stepTitle}>{step.title}</h2>
                <p className={styles.stepLine}>{step.line}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <dl className={styles.specs}>
        <div className={styles.specRow}>
          <dt className={styles.specTerm}>Needs</dt>
          <dd className={styles.specDetail}>iPhone 12 Pro or later Pro model, iOS 17.</dd>
        </div>
        <div className={styles.specRow}>
          <dt className={styles.specTerm}>After launch</dt>
          <dd className={styles.specDetail}>
            <span className={styles.cut}>
              {BRAND_NAME} Pro <span className={styles.cutNote}>Low-profile cut</span>
            </span>
            <span className={styles.cut}>
              {BRAND_NAME} Junior Max{' '}
              <span className={styles.cutNote}>Extended coverage for young players</span>
            </span>
          </dd>
        </div>
      </dl>

      <SiteFooter />
    </main>
  );
}
