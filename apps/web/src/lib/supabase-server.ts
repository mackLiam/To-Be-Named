import 'server-only';

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { assertNoPublicServiceKey } from './env';

/**
 * Anon Supabase client for reading the signed-in user's session inside server
 * components and route handlers. Uses only NEXT_PUBLIC_* values (safe) and the
 * request cookies. RLS applies to everything this client touches - it is never
 * used to read admin-only tables (pipeline_jobs, audit_log), which have no RLS
 * policies and are reachable only via the service role client.
 */
export async function createAnonServerClient() {
  assertNoPublicServiceKey();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
        'Copy .env.example (repo root) to .env and fill in your Supabase project values.',
    );
  }

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        // In a pure server-component read this can throw (cookies are
        // read-only outside actions/route handlers); that is expected and
        // safe to ignore because session refresh happens elsewhere.
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // no-op
        }
      },
    },
  });
}
