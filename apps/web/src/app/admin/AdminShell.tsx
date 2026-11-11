import Link from 'next/link';

import { BRAND_NAME } from '@forms/shared/brand';

import { Wordmark } from '../Wordmark';
import { signOut } from './actions';
import styles from './admin.module.css';
import { AdminNav } from './AdminNav';

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
        <Link href="/admin/orders" className={styles.brand} aria-label={`${BRAND_NAME} admin home`}>
          <Wordmark surface="brown" decorative className={styles.wordmark} />
          <span className={styles.panelTag}>Admin</span>
        </Link>
        <AdminNav />
        {fake ? null : (
          <form action={signOut} className={styles.signOut}>
            <button type="submit" className={styles.navButton}>
              Sign out
            </button>
          </form>
        )}
      </header>

      {fake ? (
        <div className={styles.fakeBanner} role="note">
          Fake data. No Supabase backend is configured, so this panel shows deterministic
          placeholder rows and makes no network calls. Set NEXT_PUBLIC_SUPABASE_URL,
          NEXT_PUBLIC_SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY (server-side only) to see
          live data.
        </div>
      ) : null}

      <main id="main" className={styles.main}>
        {children}
      </main>
    </div>
  );
}
