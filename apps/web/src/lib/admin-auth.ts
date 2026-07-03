import 'server-only';

import { notFound } from 'next/navigation';

import { decideAdminAccess, type AdminDecision } from './access';
import { getAdminAllowlist, isFakeMode } from './env';
import { createAnonServerClient } from './supabase-server';

/**
 * Resolve the admin access decision for the current request. Does the IO
 * (session lookup, profile role lookup) and delegates the actual allow/deny
 * logic to the pure decideAdminAccess() so that logic stays unit tested.
 *
 * Returns a decision rather than throwing, so route handlers can map "deny" to
 * a 404 Response and pages can map it to notFound().
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

  // profiles.role does not exist in the current schema (see README + report).
  // Read it defensively: any error (including "column does not exist") falls
  // back to the email allowlist rather than crashing the request.
  let profileRole: string | null = null;
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('user_id', user.id)
      .maybeSingle();
    const role = (profile as { role?: unknown } | null)?.role;
    profileRole = typeof role === 'string' ? role : null;
  } catch {
    profileRole = null;
  }

  return decideAdminAccess({
    fakeMode: false,
    user: { id: user.id, email: user.email ?? null },
    profileRole,
    allowlist: getAdminAllowlist(),
  });
}

export interface AdminContext {
  fake: boolean;
}

/**
 * Gate for admin pages: a non-admin gets a 404 (notFound), never a login wall
 * that reveals the panel exists.
 */
export async function requireAdmin(): Promise<AdminContext> {
  const decision = await getAdminDecision();
  if (decision.kind === 'deny') {
    notFound();
  }
  return { fake: decision.kind === 'fake' };
}
