import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Whether the user has a pending account deletion request (0012
 * account_deletion_requests). SERVICE ROLE client only: clients cannot read
 * that table. Checkout and the admin remake panel both refuse new work for
 * such a user, because the service role skips the RLS check that does it.
 */
export async function hasDeletionRequest(client: SupabaseClient, userId: string): Promise<boolean> {
  const { count, error } = await client
    .from('account_deletion_requests')
    .select('user_id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) {
    throw error;
  }
  return (count ?? 0) > 0;
}
