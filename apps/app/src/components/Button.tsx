import type { PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { buttonA11y } from '../lib/uiState';
import { colors, maxFontScale, radius, sizing, spacing, typography } from '../theme/tokens';

type Variant = 'primary' | 'secondary' | 'outline' | 'danger' | 'text';

interface ButtonProps extends PropsWithChildren {
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
  /** Work in flight: shows a spinner beside the label and blocks a second tap. */
  busy?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: ViewStyle;
}

/**
 * Full-width rectangle with the one radius token, never a pill (banned look #3).
 * Sentence-case labels; side-by-side buttons pass style={{ flex: 1 }}.
 *
 * Variant contrast (checked in src/theme/tokens.test.ts):
 * - primary: action (brick 600) fill, yellow text, 4.7:1.
 * - secondary: stud brown fill, yellow text.
 * - outline: brown border and text on the yellow field.
 * - danger: oxblood fill, yellow text; destructive confirms only.
 * - text: no fill, brick 600 label (small action text on yellow, 4.7:1).
 * - disabled: kraft (brown 100) fill, brown 500 label. WCAG exempts disabled
 *   controls; it is still kept at large-text contrast so the words stay readable.
 */
export function Button({
  children,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  accessibilityLabel,
  accessibilityHint,
  style,
}: ButtonProps) {
  const a11y = buttonA11y({ disabled, busy, label: accessibilityLabel, hint: accessibilityHint });
  const inert = a11y.accessibilityState.disabled;
  const labelColor = VARIANT_LABEL[variant].color;
  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      {...a11y}
      style={({ pressed }) => [
        styles.base,
        variant === 'text' && styles.textBase,
        VARIANT_CONTAINER[variant],
        pressed && !inert && PRESSED_CONTAINER[variant],
        // A busy button keeps full color: it is working, not unavailable.
        disabled && !busy && DISABLED_CONTAINER[variant],
        style,
      ]}
    >
      <View style={styles.inner}>
        {busy && <ActivityIndicator size="small" color={labelColor} />}
        <Text
          maxFontSizeMultiplier={maxFontScale.button}
          style={[styles.label, VARIANT_LABEL[variant], disabled && !busy && DISABLED_LABEL]}
        >
          {children}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: sizing.control,
    borderRadius: radius,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  textBase: {
    minHeight: sizing.hitTarget,
    paddingHorizontal: spacing.sm,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  label: {
    ...typography.button,
    textAlign: 'center',
    flexShrink: 1,
  },
});

const VARIANT_CONTAINER: Record<Variant, ViewStyle> = {
  primary: { backgroundColor: colors.action },
  secondary: { backgroundColor: colors.surfaceDark },
  outline: { borderWidth: 2, borderColor: colors.textPrimary },
  danger: { backgroundColor: colors.danger },
  text: {},
};

/**
 * Disabled is a flat kraft block, not a faded brand color: brick at 40%
 * opacity over yellow reads as orange, a color the brand does not have.
 */
const DISABLED_CONTAINER: Record<Variant, ViewStyle> = {
  primary: { backgroundColor: colors.border },
  secondary: { backgroundColor: colors.border },
  outline: { borderColor: colors.disabled },
  danger: { backgroundColor: colors.border },
  text: {},
};

const DISABLED_LABEL = { color: colors.textTertiary };

const PRESSED_CONTAINER: Record<Variant, ViewStyle> = {
  primary: { backgroundColor: colors.actionPressed },
  secondary: { backgroundColor: colors.brown[700] },
  outline: { backgroundColor: colors.surfaceMuted },
  danger: { backgroundColor: colors.surfaceDark },
  text: { backgroundColor: colors.surfaceMuted },
};

const VARIANT_LABEL: Record<Variant, { color: string }> = {
  primary: { color: colors.onAction },
  secondary: { color: colors.onDark },
  outline: { color: colors.textPrimary },
  danger: { color: colors.onAction },
  text: { color: colors.action },
};
