import type { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';

import { colors, radius, spacing, typography } from '../theme/tokens';

type Variant = 'primary' | 'secondary' | 'outline' | 'danger' | 'text';

interface ButtonProps extends PropsWithChildren {
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
  accessibilityLabel?: string;
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
 */
export function Button({
  children,
  onPress,
  variant = 'primary',
  disabled = false,
  accessibilityLabel,
  style,
}: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.base,
        variant === 'text' && styles.textBase,
        VARIANT_CONTAINER[variant],
        pressed && !disabled && PRESSED_CONTAINER[variant],
        disabled && styles.disabled,
        style,
      ]}
    >
      <Text style={[styles.label, VARIANT_LABEL[variant]]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 56,
    borderRadius: radius,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  textBase: {
    minHeight: 44,
    paddingHorizontal: spacing.sm,
  },
  label: {
    ...typography.button,
    textAlign: 'center',
  },
  disabled: {
    opacity: 0.4,
  },
});

const VARIANT_CONTAINER: Record<Variant, ViewStyle> = {
  primary: { backgroundColor: colors.action },
  secondary: { backgroundColor: colors.surfaceDark },
  outline: { borderWidth: 2, borderColor: colors.textPrimary },
  danger: { backgroundColor: colors.danger },
  text: {},
};

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
