/**
 * Admin access decision logic, kept free of any framework imports so it can be
 * unit tested in isolation and reused by both server components (which turn a
 * "deny" into notFound()) and the route handler (which turns it into a 404
 * Response). Non-admins must get a 404, never a login wall that reveals the
 * admin panel exists (DESIGN.md section 9.2, task brief).
 */

export interface AdminUser {
  id: string;
  email: string | null;
}

export type AdminDecision =
  { kind: 'fake' } | { kind: 'allow'; user: AdminUser } | { kind: 'deny' };

/**
 * Is this user an admin? Two mechanisms, checked in order:
 *  1. profiles.role === 'admin' (the intended long-term mechanism; requires a
 *     migration to add the column, which does not exist yet - see README).
 *  2. email is in the ADMIN_ALLOWLIST env var (bootstrap, works today).
 */
export function isAdmin(input: {
  profileRole: string | null;
  email: string | null;
  allowlist: string[];
}): boolean {
  if (input.profileRole === 'admin') {
    return true;
  }
  if (input.email && input.allowlist.includes(input.email.toLowerCase())) {
    return true;
  }
  return false;
}

export function decideAdminAccess(input: {
  fakeMode: boolean;
  user: AdminUser | null;
  profileRole: string | null;
  allowlist: string[];
}): AdminDecision {
  if (input.fakeMode) {
    return { kind: 'fake' };
  }
  if (!input.user) {
    return { kind: 'deny' };
  }
  if (
    isAdmin({
      profileRole: input.profileRole,
      email: input.user.email,
      allowlist: input.allowlist,
    })
  ) {
    return { kind: 'allow', user: input.user };
  }
  return { kind: 'deny' };
}
