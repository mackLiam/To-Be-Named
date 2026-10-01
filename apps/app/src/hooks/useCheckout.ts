import * as Linking from 'expo-linking';
import { useCallback, useState } from 'react';
import { Platform } from 'react-native';

import {
  CheckoutError,
  startCheckout,
  type CheckoutDeps,
  type CheckoutErrorCode,
  type CheckoutInput,
} from '../lib/checkout';
import { getSupabaseClient, hasSupabaseConfig } from '../lib/supabase';

function defaultDeps(): CheckoutDeps {
  return {
    // Static access: Expo inlines EXPO_PUBLIC_* only when read by name.
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    configured: hasSupabaseConfig(),
    getAccessToken: async () => {
      const { data } = await getSupabaseClient().auth.getSession();
      return data.session?.access_token ?? null;
    },
    fetch: (...args) => fetch(...args),
  };
}

/** Creates a Checkout Session and leaves the app for Stripe's page. The URL
 * is opened immediately and never kept in state. */
export function useCheckout() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CheckoutErrorCode | null>(null);

  const start = useCallback(async (input: CheckoutInput) => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await startCheckout(input, defaultDeps());
      if (Platform.OS === 'web') {
        window.location.assign(url);
      } else {
        await Linking.openURL(url);
      }
    } catch (err) {
      setError(err instanceof CheckoutError ? err.code : 'network');
    } finally {
      setBusy(false);
    }
  }, []);

  return { start, busy, error };
}
