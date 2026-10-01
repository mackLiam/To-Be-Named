import 'server-only';

import { notFound, redirect } from 'next/navigation';

import { decideAdminAccess, type AdminDecision } from './access';
import { getAdminAllowlist, isFakeMode } from './env';
import { createAnonServerClient } from './supabase-server';

/**
 * Resolve the admin access decision for the current request. Does the IO and
 * delegates allow/deny to the pure decideAdminAccess() so that logic stays
 * unit tested. auth.getUser() validates the token with the Auth server;
 * getSession() is never used for authorization because it trusts the cookie.
 *
 * Returns a decision rather than throwing, so route handlers can map it to a
 * 404 Response and pages to notFound() or the MFA redirect.
 */
export async function getAdminDecision(): Promise<AdminDecision> {
  if (isFakeMode()) {
    return { kind: 'fake' };
  }

  const supabase = await createAnonServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { kind: 'deny' };
  }

  // Any error here leaves aal null / no verified factor, which can only route
  // to an MFA step, never to allow.
  const [aalResult, factorsResult] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.auth.mfa.listFactors(),
  ]);
  const level = aalResult.data?.currentLevel;
  const hasVerifiedTotp = (factorsResult.data?.totp ?? []).some((f) => f.status === 'verified');

  return decideAdminAccess({
    fakeMode: false,
    user: {
      id: user.id,
      email: user.email ?? null,
      emailConfirmed: Boolean(user.email_confirmed_at),
    },
    allowlist: getAdminAllowlist(),
    aal: level === 'aal2' ? 'aal2' : level === 'aal1' ? 'aal1' : null,
    hasVerifiedTotp,
  });
}

export interface AdminContext {
  fake: boolean;
  /** Who to write into audit_log.actor: the admin's email, or their id. */
  actor: string;
}

/**
 * Gate for admin pages and server actions: a non-staff user gets a 404
 * (notFound), never a login wall that reveals the panel exists. Staff below
 * aal2 are sent to the TOTP step.
 */
export async function requireAdmin(): Promise<AdminContext> {
  const decision = await getAdminDecision();
  if (decision.kind === 'fake') {
    return { fake: true, actor: 'fake-mode' };
  }
  if (decision.kind === 'allow') {
    return { fake: false, actor: decision.user.email ?? decision.user.id };
  }
  if (decision.kind === 'mfa_enroll') {
    redirect('/login/mfa?enroll=1');
  }
  if (decision.kind === 'mfa_verify') {
    redirect('/login/mfa');
  }
  notFound();
}
