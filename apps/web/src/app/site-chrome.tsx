import Link from 'next/link';

import { BRAND_NAME, SUPPORT_EMAIL } from '@forms/shared/brand';

import styles from './site-chrome.module.css';
import { Wordmark } from './Wordmark';

/**
 * Every public page: skip link, brown header band, <main id="main">, brown
 * footer band. Header and footer sit outside <main> so they keep their
 * banner and contentinfo landmarks.
 */
export function SitePage({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={styles.frame}>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className={`${styles.main} ${className ?? ''}`}>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className={styles.topbar}>
      <Link href="/" aria-label={`${BRAND_NAME} home`} className={styles.home}>
        <Wordmark surface="brown" decorative className={styles.wordmark} />
      </Link>
      <span className={styles.status}>Coming soon</span>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <Wordmark surface="brown" className={styles.footerMark} />
      <nav aria-label="Site" className={styles.nav}>
        <Link href="/support">Support</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </nav>
    </footer>
  );
}
