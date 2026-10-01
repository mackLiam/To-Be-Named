import * as Linking from 'expo-linking';
import type { PropsWithChildren } from 'react';
import { Platform, Text } from 'react-native';

import { colors } from '../theme/tokens';

/**
 * Inline link inside a Body; opens the URL outside the app. On web it renders
 * a real anchor (react-native-web reads href) instead of also calling
 * openURL, which would open the page twice.
 */
export function TextLink({ href, children }: PropsWithChildren<{ href: string }>) {
  const web = Platform.OS === 'web';
  const anchor = web ? { href, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } } : {};
  return (
    <Text
      {...anchor}
      accessibilityRole="link"
      accessibilityHint="Opens outside the app"
      onPress={web ? undefined : () => void Linking.openURL(href)}
      style={{ color: colors.action, textDecorationLine: 'underline' }}
    >
      {children}
    </Text>
  );
}
