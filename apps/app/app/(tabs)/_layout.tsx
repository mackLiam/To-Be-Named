import { Feather } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { tabBarLabelStyle, tabBarStyle } from '../../src/theme/navigation';
import { colors } from '../../src/theme/tokens';

type IconName = keyof typeof Feather.glyphMap;

function tabIcon(name: IconName) {
  return ({ color, size }: { color: ColorValue; size: number }) => (
    <Feather name={name} color={color as string} size={size} />
  );
}

export default function TabsLayout() {
  // Height follows the real inset: a fixed 84 pt clips on some devices and
  // wastes space on web and Android, where the bottom inset is 0.
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.onDark,
        tabBarInactiveTintColor: colors.onDarkMuted,
        tabBarStyle: tabBarStyle(insets.bottom),
        tabBarLabelStyle,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Scans', tabBarIcon: tabIcon('aperture') }} />
      <Tabs.Screen name="shop" options={{ title: 'Shop', tabBarIcon: tabIcon('shopping-bag') }} />
      <Tabs.Screen name="orders" options={{ title: 'Orders', tabBarIcon: tabIcon('package') }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarIcon: tabIcon('user') }} />
    </Tabs>
  );
}
