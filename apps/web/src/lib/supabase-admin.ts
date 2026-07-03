import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { assertNoPublicServiceKey, getServerSupabaseUrl, getServiceRoleKey } from './env';

/**
 * Service-role Supabase client. Bypasses RLS, so it is the only way to read the
 * admin-only tables (pipeline_jobs, audit_log) and to write audit rows / issue
 * STL signed URLs. SERVER ONLY: the 'server-only' import above makes importing
 * this from any client component a build error, and the key is read from a non
 * NEXT_PUBLIC variable. Never persists a session (no cookies, no auto refresh).
 */
export function createServiceRoleClient(): SupabaseClient {
  assertNoPublicServiceKey();

  const url = getServerSupabaseUrl();
  const serviceKey = getServiceRoleKey();
  if (!url || !serviceKey) {
    throw new Error(
      'createServiceRoleClient called without configuration. Set SUPABASE_SERVICE_ROLE_KEY ' +
        'and SUPABASE_URL (server-side only). Callers must gate on hasServiceRoleConfig() first.',
    );
  }

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
