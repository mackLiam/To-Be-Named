import type { PropsWithChildren } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '../theme/tokens';

interface ScreenProps extends PropsWithChildren {
  scroll?: boolean;
  /** Enables pull-to-refresh on scrolling screens. */
  onRefresh?: () => void;
  refreshing?: boolean;
}

/**
 * Base page frame: card yellow field, generous left-aligned margins, no centered
 * max-width container. Every tab screen wraps its content in this so spacing
 * stays consistent without every screen re-deriving it.
 */
export function Screen({ children, scroll = true, onRefresh, refreshing = false }: ScreenProps) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      {scroll ? (
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
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.container, styles.content]}>{children}</View>
      )}
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
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
  },
});
