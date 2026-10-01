import * as Linking from 'expo-linking';
import type { PropsWithChildren } from 'react';
import { Text } from 'react-native';

/** Inline link inside a Body; opens the URL outside the app. */
export function TextLink({ href, children }: PropsWithChildren<{ href: string }>) {
  return (
    <Text
      accessibilityRole="link"
      onPress={() => void Linking.openURL(href)}
      style={{ textDecorationLine: 'underline' }}
    >
      {children}
    </Text>
  );
}
