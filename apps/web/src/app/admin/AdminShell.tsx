import Link from 'next/link';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from './admin.module.css';

/**
 * Chrome for every admin page. Rendered only after the page has already passed
 * the server-side admin gate (requireAdmin), so the shell never appears to a
 * non-admin. When the backend is absent it shows a loud fake-data strip so the
 * placeholder rows can never be mistaken for production data.
 */
export function AdminShell({ fake, children }: { fake: boolean; children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element -- static SVG wordmark, nothing to optimize */}
          <img
            src="/brand/wordmark-reverse-for-brown.svg"
            alt={BRAND_NAME}
            className={styles.wordmark}
          />
          <span className={styles.panelTag}>Admin</span>
        </div>
        <nav className={styles.nav}>
          <Link href="/admin" className={styles.navLink}>
            Pipeline queue
          </Link>
        </nav>
      </header>

      {fake ? (
        <div className={styles.fakeBanner}>
          Fake data. No Supabase backend is configured, so this panel shows deterministic
          placeholder rows and makes no network calls. Set NEXT_PUBLIC_SUPABASE_URL,
          NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY (server-side only) to see
          live data.
        </div>
      ) : null}

      <main className={styles.main}>{children}</main>
    </div>
  );
}
