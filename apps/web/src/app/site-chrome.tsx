import Link from 'next/link';

import { BRAND_NAME, SUPPORT_EMAIL } from '@forms/shared/brand';

import styles from './site-chrome.module.css';

export function SiteHeader() {
  return (
    <header className={styles.topbar}>
      <Link href="/" aria-label={`${BRAND_NAME} home`} className={styles.home}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static SVG wordmark, nothing to optimize */}
        <img src="/brand/wordmark-reverse-for-brown.svg" alt="" className={styles.wordmark} />
      </Link>
      <span className={styles.status}>Coming soon</span>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      {/* eslint-disable-next-line @next/next/no-img-element -- static SVG wordmark, nothing to optimize */}
      <img
        src="/brand/wordmark-reverse-for-brown.svg"
        alt={BRAND_NAME}
        className={styles.footerMark}
      />
      <nav aria-label="Site" className={styles.nav}>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/support">Support</Link>
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </nav>
    </footer>
  );
}
