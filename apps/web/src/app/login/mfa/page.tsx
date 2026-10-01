import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { BRAND_NAME } from '@forms/shared/brand';

import styles from '../../admin/admin.module.css';
import { isTotpCode, pickTotpFactorId, staleTotpFactorIds } from '@/lib/access';
import { getAdminDecision } from '@/lib/admin-auth';
import { createAnonServerClient } from '@/lib/supabase-server';

export const metadata: Metadata = {
  title: `Sign in - ${BRAND_NAME}`,
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Step two of staff sign-in: TOTP enrollment or verification, raising the
 * session to aal2. Only an allowlisted, email-confirmed signed-in user ever
 * sees it (everyone else gets a 404). The mode comes from the server-side
 * decision, never from the query string, so ?enroll=1 cannot add a second
 * factor to an account that already has one.
 */

/** Resolves the MFA step, or ends the request for anyone not on it. */
async function mfaStep(): Promise<'mfa_enroll' | 'mfa_verify'> {
  const decision = await getAdminDecision();
  if (decision.kind === 'allow') {
    redirect('/admin/orders');
  }
  if (decision.kind !== 'mfa_enroll' && decision.kind !== 'mfa_verify') {
    notFound();
  }
  return decision.kind;
}

async function verifyCode(formData: FormData) {
  'use server';
  const step = await mfaStep();
  const back = step === 'mfa_enroll' ? '/login/mfa?enroll=1&error=1' : '/login/mfa?error=1';
  const code = String(formData.get('code') ?? '').replace(/\s/g, '');
  if (!isTotpCode(code)) {
    redirect(back);
  }
  const supabase = await createAnonServerClient();
  const { data } = await supabase.auth.mfa.listFactors();
  const factorId = pickTotpFactorId(data?.all ?? []);
  if (!factorId) {
    redirect(back);
  }
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  if (error) {
    redirect(back);
  }
  redirect('/admin/orders');
}

async function signOut() {
  'use server';
  const supabase = await createAnonServerClient();
  await supabase.auth.signOut();
  redirect('/login');
}

/** Fresh TOTP enrollment; stale unverified factors are removed first. */
async function startEnrollment(): Promise<{ qr: string; secret: string } | null> {
  const supabase = await createAnonServerClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const factorId of staleTotpFactorIds(factors?.all ?? [])) {
    await supabase.auth.mfa.unenroll({ factorId });
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: 'FORMS admin',
  });
  if (error || !data) {
    return null;
  }
  return { qr: data.totp.qr_code, secret: data.totp.secret };
}

export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const step = await mfaStep();
  const enrollment = step === 'mfa_enroll' ? await startEnrollment() : null;

  return (
    <main className={styles.loginWrap}>
      <h1 className={styles.title}>
        {step === 'mfa_enroll' ? 'Set up your authenticator' : 'Enter your code'}
      </h1>
      {sp.error ? <p className={styles.formError}>That code did not work. Try again.</p> : null}
      {step === 'mfa_enroll' && !enrollment ? (
        <p className={styles.formError}>Could not start setup. Reload the page to try again.</p>
      ) : (
        <form action={verifyCode} className={styles.form}>
          {enrollment ? (
            <>
              <p className={styles.subtitle}>
                Scan this code with an authenticator app, then enter the 6-digit code it shows. Each
                visit to this page makes a new code; remove any older entry from your app.
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element -- SVG data URI from Supabase, nothing to optimize */}
              <img src={enrollment.qr} alt="Authenticator QR code" width={180} height={180} />
              <div className={styles.field}>
                <span className={styles.fieldLabel}>Or enter this key</span>
                <code className={styles.mono}>{enrollment.secret}</code>
              </div>
            </>
          ) : (
            <p className={styles.subtitle}>Enter the 6-digit code from your authenticator app.</p>
          )}
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Code</span>
            <input
              className={styles.input}
              type="text"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              minLength={6}
              maxLength={6}
              required
            />
          </label>
          <button type="submit" className={styles.downloadBtn}>
            Verify
          </button>
        </form>
      )}
      <form action={signOut} className={styles.form}>
        <button type="submit" className={styles.secondaryBtn}>
          Sign out
        </button>
      </form>
    </main>
  );
}
