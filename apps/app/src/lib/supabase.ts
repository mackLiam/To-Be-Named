import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client, lazily created. Only EXPO_PUBLIC_* values are read here -
 * anything in the app bundle is public, so no service keys, ever (see
 * CLAUDE.md gotcha 5 and docs/DESIGN.md section 9).
 *
 * Lazy init matters for two reasons:
 * 1. Phase 0/1: the app must run with zero backend configured (see
 *    src/lib/api.ts USE_FAKE_DATA).
 * 2. Expo's static web export pre-renders modules at build time; throwing at
 *    module load would break that build even when no screen actually needs
 *    Supabase yet. The error only fires when a caller actually asks for a
 *    client.
 */
let client: SupabaseClient | null = null;

export function hasSupabaseConfig(): boolean {
  return Boolean(process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
}

export function getSupabaseClient(): SupabaseClient {
  if (client) {
    return client;
  }

  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
        'Copy .env.example (repo root) to .env and fill in your Supabase project values.',
    );
  }

  client = createClient(url, anonKey);
  return client;
}
