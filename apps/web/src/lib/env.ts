/**
 * Environment gating and hard security assertions.
 *
 * Every value is read through a function (never a module-load constant) so
 * that behavior tracks the current process.env at call time - this keeps the
 * fake-data fallback correct across server requests and makes the logic unit
 * testable by mutating process.env.
 *
 * Security invariant (CLAUDE.md gotcha 5, DESIGN.md section 9.2): the service
 * role key has full database access and must NEVER reach a client bundle. It
 * is read only from a plain (non NEXT_PUBLIC) variable, server-side. If anyone
 * ever defines a NEXT_PUBLIC_* variable that looks like a service key, we fail
 * loudly rather than ship it.
 */

export function hasSupabaseConfig(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Fake-data mode: no backend is configured, so admin pages render clearly
 * labeled placeholder data and never attempt a network call. This is the
 * Phase 0/1 "runs with zero backend" guarantee, mirroring
 * apps/app/src/lib/api.ts USE_FAKE_DATA.
 */
export function isFakeMode(): boolean {
  return !hasSupabaseConfig();
}

/**
 * The service role client can only be built when a service key AND a
 * server-side Supabase URL are present. SUPABASE_URL is preferred; we fall
 * back to NEXT_PUBLIC_SUPABASE_URL for the URL only (a URL is not a secret).
 */
export function hasServiceRoleConfig(): boolean {
  return Boolean(
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
  );
}

export function getServerSupabaseUrl(): string | undefined {
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
}

export function getServiceRoleKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

/**
 * Comma-separated bootstrap admin allowlist (emails). Needed because the
 * current database schema has no way to mark a user as admin yet (see
 * apps/web/README.md and the final report: profiles.role does not exist).
 * Until a migration adds profiles.role, this env var is the working admin
 * mechanism.
 */
export function getAdminAllowlist(): string[] {
  return (process.env.ADMIN_ALLOWLIST ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

const SERVICE_KEY_PATTERN = /SERVICE_ROLE|SERVICE_KEY|SECRET/i;

/**
 * Throws if any NEXT_PUBLIC_* variable looks like a server secret. Called at
 * the top of every server module that touches the service role, so a
 * misconfiguration fails the build/request instead of leaking a key into the
 * client bundle.
 */
export function assertNoPublicServiceKey(
  env: Record<string, string | undefined> = process.env,
): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('NEXT_PUBLIC_') && SERVICE_KEY_PATTERN.test(key)) {
      throw new Error(
        `Refusing to start: ${key} is a NEXT_PUBLIC_* variable whose name looks ` +
          'like a server secret. Service keys must never be exposed to the client. ' +
          'Rename it to a non NEXT_PUBLIC variable (for example SUPABASE_SERVICE_ROLE_KEY).',
      );
    }
  }
}
