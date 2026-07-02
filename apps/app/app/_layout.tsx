import { Manrope_400Regular, Manrope_500Medium, Manrope_700Bold } from '@expo-google-fonts/manrope';
import { Outfit_600SemiBold, Outfit_700Bold, Outfit_800ExtraBold } from '@expo-google-fonts/outfit';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

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

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {
        // No-op: see preventAutoHideAsync above.
      });
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" />
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
      </Stack>
    </>
  );
}
