import { Feather } from '@expo/vector-icons';
import type { PropsWithChildren, ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, maxFontScale, sizing, spacing, typography } from '../theme/tokens';
import { Heading } from './Heading';

interface ScreenProps extends PropsWithChildren {
  /** Large left-aligned screen title, no trailing period. */
  title?: string;
  /** Pinned below the scroll area: the one primary action on flow screens. */
  footer?: ReactNode;
  /** Enables pull-to-refresh. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /**
   * A back control above the content, for stack screens shown without a
   * native header. On web there is no swipe-back, so without this a guided
   * screen can feel like a dead end.
   */
  back?: { label: string; onPress: () => void };
}

/**
 * Base page frame on the card yellow field. Content is left-aligned and capped
 * so buttons stay thumb-width on a wide web window; tab screens get their
 * bottom inset from the tab bar, footer screens take it here.
 */
export function Screen({
  children,
  title,
  footer,
  onRefresh,
  refreshing = false,
  back,
}: ScreenProps) {
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
        {back && <BackBar {...back} />}
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

function BackBar({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={spacing.sm}
      style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
    >
      <Feather name="chevron-left" size={22} color={colors.textPrimary} />
      <Text maxFontSizeMultiplier={maxFontScale.button} style={styles.backLabel}>
        {label}
      </Text>
    </Pressable>
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
    maxWidth: sizing.column,
    paddingHorizontal: sizing.gutter,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  title: {
    marginBottom: spacing.lg,
  },
  // The rule marks the pinned action as separate from the scrolling content.
  footer: {
    width: '100%',
    maxWidth: sizing.column,
    paddingHorizontal: sizing.gutter,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: sizing.hitTarget,
    marginLeft: -spacing.sm,
    marginTop: -spacing.md,
    marginBottom: spacing.md,
    paddingRight: spacing.sm,
    gap: spacing.xs,
  },
  backPressed: { opacity: 0.6 },
  backLabel: { ...typography.button, color: colors.textPrimary },
});
