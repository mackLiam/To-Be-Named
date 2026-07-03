import type { Metadata } from 'next';

import styles from './page.module.css';

export const metadata: Metadata = {
  title: 'Zells - shin guards molded to your leg',
  description:
    'Custom-fit, 3D-printed soccer shin guards. Scan your leg with your iPhone, we generate the fit, we print and ship it.',
};

const steps = [
  {
    n: '1',
    title: 'Scan your leg',
    body: 'Open the Zells app and follow the guided capture. Your iPhone builds a precise 3D scan of your lower leg in about a minute. No tape measure, no guessing.',
  },
  {
    n: '2',
    title: 'We generate your fit',
    body: 'The scan is turned into 25 measurements that drive our parametric guard model. Every curve, every wall thickness is built to your leg, automatically.',
  },
  {
    n: '3',
    title: 'Printed and shipped',
    body: 'Your guard is 3D printed to those exact measurements and sent to your door. One scan, and reorders never need another.',
  },
];

const specs = [
  { term: 'Device', detail: 'iPhone 12 Pro or later Pro model (LiDAR required)' },
  { term: 'iOS', detail: 'iOS 17 or later' },
  { term: 'Where', detail: 'The Zells iPhone app. Android and web ordering come later.' },
  { term: 'Time', detail: 'About a minute to scan each leg.' },
];

export default function HomePage() {
  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <span className={styles.wordmark}>ZELLS</span>
        <span className={styles.status}>Coming soon</span>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>Custom-fit soccer shin guards</p>
          <h1 className={styles.headline}>
            Shin guards molded to <span className={styles.accent}>your leg.</span>
          </h1>
          <p className={styles.subhead}>
            Scan your leg with your iPhone. We turn the scan into a guard printed to fit only you:
            no more slipping, pinching, or one-size-fits-nobody plastic.
          </p>
        </div>

        <div className={styles.guard} aria-hidden="true">
          <div className={styles.guardShell} />
          <div className={styles.guardStrut} />
          <div className={styles.guardRib} style={{ top: '30%' }} />
          <div className={styles.guardRib} style={{ top: '50%' }} />
          <div className={styles.guardRib} style={{ top: '70%' }} />
        </div>
      </section>

      <section className={styles.steps}>
        <p className={styles.sectionLabel}>How it works</p>
        {steps.map((step) => (
          <div key={step.n} className={styles.step}>
            <div className={styles.stepNum}>{step.n}</div>
            <div>
              <h2 className={styles.stepTitle}>{step.title}</h2>
              <p className={styles.stepBody}>{step.body}</p>
            </div>
          </div>
        ))}
      </section>

      <section className={styles.requirements}>
        <div className={styles.requirementsInner}>
          <h2 className={styles.requirementsTitle}>What you need</h2>
          {specs.map((spec) => (
            <div key={spec.term} className={styles.specRow}>
              <span className={styles.specTerm}>{spec.term}</span>
              <span className={styles.specDetail}>{spec.detail}</span>
            </div>
          ))}
        </div>
      </section>

      <footer className={styles.footer}>
        <span className={styles.wordmark}>ZELLS</span>
        <p className={styles.footerNote}>
          We are building the scan-to-print pipeline now. No signup yet: check back for the launch.
        </p>
      </footer>
    </main>
  );
}
