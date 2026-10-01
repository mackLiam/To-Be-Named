import { Manrope_400Regular, Manrope_500Medium, Manrope_700Bold } from '@expo-google-fonts/manrope';
import { Outfit_600SemiBold, Outfit_700Bold, Outfit_800ExtraBold } from '@expo-google-fonts/outfit';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { AccountProvider, useAccount } from '../src/hooks/useAccount';
import { colors } from '../src/theme/tokens';

SplashScreen.preventAutoHideAsync().catch(() => {
  // No-op: this only fails if the splash screen already hid, which is fine.
});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Outfit_800ExtraBold,
    Outfit_700Bold,
    Outfit_600SemiBold,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_700Bold,
  });

  return (
    <AccountProvider>
      <RootStack fontsReady={fontsLoaded || Boolean(fontError)} />
    </AccountProvider>
  );
}

/**
 * Every product route sits behind a session (guest or member): scans and
 * orders are owner-scoped by RLS, so there is nothing to show without an
 * auth.uid(). Flipping the guard unmounts the other side, which is what keeps
 * one user's fetched rows from surviving into the next user's session. A
 * guest merging into an existing account changes user without passing
 * through signed out, so the stack is also keyed on the user id.
 */
function RootStack({ fontsReady }: { fontsReady: boolean }) {
  const { loading, account } = useAccount();
  const ready = fontsReady && !loading;

  useEffect(() => {
    if (ready) {
      SplashScreen.hideAsync().catch(() => {
        // No-op: see preventAutoHideAsync above.
      });
    }
  }, [ready]);

  if (!ready) {
    return null;
  }

  return (
    <>
      <StatusBar style="dark" />
      <Stack
        key={account?.userId ?? 'signed-out'}
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Protected guard={account !== null}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="capture" />
          <Stack.Screen name="measure/[scanId]" />
          <Stack.Screen
            name="scan/[key]"
            options={{
              headerShown: true,
              headerTitle: 'Scan',
              headerBackTitle: 'Scans',
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.textPrimary,
              headerShadowVisible: false,
            }}
          />
          <Stack.Screen
            name="capture-info"
            options={{
              headerShown: true,
              headerTitle: 'Scan requirements',
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.textPrimary,
              presentation: 'modal',
            }}
          />
          <Stack.Screen
            name="order/[key]"
            options={{
              headerShown: true,
              headerTitle: 'Order',
              headerBackTitle: 'Scan',
              headerStyle: { backgroundColor: colors.background },
              headerTintColor: colors.textPrimary,
              headerShadowVisible: false,
            }}
          />
        </Stack.Protected>
        <Stack.Protected guard={account === null}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
      </Stack>
    </>
  );
}
