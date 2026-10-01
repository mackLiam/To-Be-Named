import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { authStorage, bindAutoRefresh } from './authStorage';

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

function config(): { url: string; anonKey: string } {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
        'Copy .env.example (repo root) to .env and fill in your Supabase project values.',
    );
  }
  return { url, anonKey };
}

export function getSupabaseClient(): SupabaseClient {
  if (client) {
    return client;
  }

  const { url, anonKey } = config();
  client = createClient(url, anonKey, {
    auth: {
      storage: authStorage,
      persistSession: true,
      autoRefreshToken: true,
      // Sign-in is by typed one-time code, never a redirect back into the app.
      detectSessionInUrl: false,
    },
  });
  bindAutoRefresh(client);
  return client;
}

/** Auth options for a client whose session must never reach the app: it is
 * not persisted, not refreshed, and keyed apart from the main client. */
export const THROWAWAY_AUTH_OPTIONS = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
  storageKey: 'forms-throwaway',
} as const;

/**
 * A fresh client that holds a session only in memory. Used to sign a second
 * user in (the guest merge, src/lib/auth.ts) without touching the main
 * client's session until the caller explicitly hands it over.
 */
export function createThrowawayClient(): SupabaseClient {
  const { url, anonKey } = config();
  const memory = new Map<string, string>();
  return createClient(url, anonKey, {
    auth: {
      ...THROWAWAY_AUTH_OPTIONS,
      storage: {
        getItem: (key) => memory.get(key) ?? null,
        setItem: (key, value) => void memory.set(key, value),
        removeItem: (key) => void memory.delete(key),
      },
    },
  });
}
