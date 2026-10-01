import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../admin/admin.module.css';
import { isFakeMode } from '@/lib/env';
import { createAnonServerClient } from '@/lib/supabase-server';

export const metadata: Metadata = {
  title: `Sign in - ${BRAND_NAME}`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Plain staff sign-in. Deliberately says nothing about an admin panel: a
 * non-admin who signs in still gets a 404 at /admin (access.ts), so this page
 * reveals no more than that the site has accounts. Admin users are created
 * in the Supabase dashboard; there is no sign-up here.
 */
async function signIn(formData: FormData) {
  'use server';
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');
  if (!email || !password || email.length > 320 || password.length > 200) {
    redirect('/login?error=1');
  }
  const supabase = await createAnonServerClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect('/login?error=1');
  }
  redirect('/admin/orders');
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const fake = isFakeMode();

  return (
    <main className={styles.loginWrap}>
      <h1 className={styles.title}>Sign in</h1>
      {fake ? (
        <p className={styles.subtitle}>
          No backend is configured, so there is nothing to sign in to. The admin panel is open in
          fake-data mode at /admin.
        </p>
      ) : (
        <form action={signIn} className={styles.form}>
          {sp.error ? <p className={styles.formError}>Email or password is incorrect.</p> : null}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Email</span>
            <input
              className={styles.input}
              type="email"
              name="email"
              autoComplete="email"
              required
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Password</span>
            <input
              className={styles.input}
              type="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" className={styles.downloadBtn}>
            Sign in
          </button>
        </form>
      )}
    </main>
  );
}
