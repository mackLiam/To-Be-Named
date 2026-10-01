import type { SupabaseClient, SupportedStorage } from '@supabase/supabase-js';

/**
 * Web (and node tests): supabase-js persists to localStorage by itself and its
 * refresh timer runs normally, so there is nothing to configure. The native
 * counterpart is authStorage.native.ts, picked by Metro on iOS/Android; keeping
 * the split in file names keeps react-native out of the node test graph.
 */
export const authStorage: SupportedStorage | undefined = undefined;

export function bindAutoRefresh(_client: SupabaseClient): void {}
