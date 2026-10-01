import type { PropsWithChildren, ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '../theme/tokens';
import { Heading } from './Heading';

interface ScreenProps extends PropsWithChildren {
  /** Large left-aligned screen title, no trailing period. */
  title?: string;
  /** Pinned below the scroll area: the one primary action on flow screens. */
  footer?: ReactNode;
  /** Enables pull-to-refresh. */
  onRefresh?: () => void;
  refreshing?: boolean;
}

/**
 * Base page frame on the card yellow field. Content is left-aligned and capped
 * so buttons stay thumb-width on a wide web window; tab screens get their
 * bottom inset from the tab bar, footer screens take it here.
 */
export function Screen({ children, title, footer, onRefresh, refreshing = false }: ScreenProps) {
  return (
    <SafeAreaView
      style={styles.safeArea}
      edges={footer ? ['top', 'left', 'right', 'bottom'] : ['top', 'left', 'right']}
    >
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        // A tap on a button while the keyboard is up should press it, not
        // only dismiss the keyboard (sign-in and profile forms).
        keyboardShouldPersistTaps="handled"
        refreshControl={
          onRefresh && (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.textPrimary}
              colors={[colors.action]}
            />
          )
        }
      >
        {title && (
          <Heading level="h1" style={styles.title}>
            {title}
          </Heading>
        )}
        {children}
      </ScrollView>
      {footer && <View style={styles.footer}>{footer}</View>}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
  },
  content: {
    width: '100%',
    maxWidth: 560,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  title: {
    marginBottom: spacing.lg,
  },
  footer: {
    width: '100%',
    maxWidth: 560,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.xs,
  },
});
