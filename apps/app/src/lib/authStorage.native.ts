import type { SupabaseClient, SupportedStorage } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';

import { chunkedStorage } from './chunkedStorage';

/** OWASP MASVS-STORAGE: the refresh token lives in the Keychain/Keystore,
 * readable after first unlock, excluded from backups and never migrated to
 * another device (a restored phone signs in again). */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const authStorage: SupportedStorage | undefined = chunkedStorage({
  getItem: (key) => SecureStore.getItemAsync(key, OPTIONS),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  deleteItem: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
});

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
