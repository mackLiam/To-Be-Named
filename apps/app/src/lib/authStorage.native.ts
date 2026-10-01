import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient, SupportedStorage } from '@supabase/supabase-js';
import { AppState } from 'react-native';

/** Native has no default session store; without one a sign-in dies on restart. */
export const authStorage: SupportedStorage | undefined = AsyncStorage;

/** Native timers stall in the background, so refresh tokens only while the app
 * is foregrounded (supabase-js React Native guidance). */
export function bindAutoRefresh(client: SupabaseClient): void {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void client.auth.startAutoRefresh();
    } else {
      void client.auth.stopAutoRefresh();
    }
  });
}
