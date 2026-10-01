/**
 * Admin access decision logic, kept free of any framework imports so it can be
 * unit tested in isolation and reused by server components, server actions and
 * the STL route handler. Anyone who is not an allowlisted, email-confirmed
 * staff user gets a 404, never a login wall that reveals the admin panel
 * exists (DESIGN.md section 9.2).
 *
 * Authorization reads only server-held or server-validated facts: the
 * ADMIN_ALLOWLIST env var, and the user, email confirmation, assurance level
 * and factors as reported by Supabase Auth. It must never read a table row the
 * user can write (0002_rls.sql lets users insert/update their own profiles row
 * with any columns, so a role column there would be self-promotable).
 */

export interface AdminUser {
  id: string;
  email: string | null;
}

export interface AdminCandidate extends AdminUser {
  emailConfirmed: boolean;
}

export type AdminDecision =
  | { kind: 'fake' }
  | { kind: 'allow'; user: AdminUser }
  | { kind: 'deny' }
  | { kind: 'mfa_enroll' }
  | { kind: 'mfa_verify' };

export function isAllowlisted(email: string | null, allowlist: string[]): boolean {
  return Boolean(email && allowlist.includes(email.toLowerCase()));
}

export function decideAdminAccess(input: {
  fakeMode: boolean;
  user: AdminCandidate | null;
  allowlist: string[];
  aal: 'aal1' | 'aal2' | null;
  hasVerifiedTotp: boolean;
}): AdminDecision {
  if (input.fakeMode) {
    return { kind: 'fake' };
  }
  const user = input.user;
  if (!user || !user.emailConfirmed || !isAllowlisted(user.email, input.allowlist)) {
    return { kind: 'deny' };
  }
  if (input.aal !== 'aal2') {
    return { kind: input.hasVerifiedTotp ? 'mfa_verify' : 'mfa_enroll' };
  }
  return { kind: 'allow', user: { id: user.id, email: user.email } };
}

/** Server-side gate for TOTP codes before they reach Supabase. */
export function isTotpCode(code: string): boolean {
  return /^\d{6}$/.test(code);
}

export interface FactorSummary {
  id: string;
  factor_type: string;
  status: string;
  created_at: string;
}

/**
 * Unverified TOTP factors left by abandoned enrollments. Removed before a new
 * enroll so they never block it.
 */
export function staleTotpFactorIds(factors: FactorSummary[]): string[] {
  return factors
    .filter((f) => f.factor_type === 'totp' && f.status !== 'verified')
    .map((f) => f.id);
}

/**
 * The TOTP factor a submitted code is checked against: the verified one if it
 * exists, else the newest unverified one (the enrollment just shown). Chosen
 * server-side from the user's own factors, never from a form field.
 */
export function pickTotpFactorId(factors: FactorSummary[]): string | null {
  const totp = factors.filter((f) => f.factor_type === 'totp');
  const verified = totp.find((f) => f.status === 'verified');
  if (verified) {
    return verified.id;
  }
  const newest = totp
    .filter((f) => f.status === 'unverified')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return newest?.id ?? null;
}
