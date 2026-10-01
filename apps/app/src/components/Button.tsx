import type { PropsWithChildren } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, radius, spacing, typography } from '../theme/tokens';

type Variant = 'primary' | 'secondary' | 'outline';

interface ButtonProps extends PropsWithChildren {
  onPress?: () => void;
  variant?: Variant;
  disabled?: boolean;
}

/**
 * A rectangle, always - one radius token, no pill shape (banned look #3).
 *
 * Variant contrast (see src/theme/tokens.test.ts for the checked ratios):
 * - primary: action (brick 600) fill, yellow text - 4.7:1, passes AA.
 * - secondary: stud brown fill, yellow text - 8.8:1.
 * - outline: yellow fill, brown border and text - for tertiary actions.
 * Brand brick 500 and bright brick are never label colors in this file.
 */
export function Button({ children, onPress, variant = 'primary', disabled = false }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.base,
        VARIANT_CONTAINER[variant],
        pressed && !disabled && PRESSED_CONTAINER[variant],
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.label, VARIANT_LABEL[variant]]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  label: {
    ...typography.label,
    textTransform: 'uppercase',
  },
  disabled: {
    opacity: 0.4,
  },
});

const VARIANT_CONTAINER: Record<Variant, object> = {
  primary: { backgroundColor: colors.action },
  secondary: { backgroundColor: colors.surfaceDark },
  outline: { backgroundColor: colors.background, borderWidth: 1, borderColor: colors.textPrimary },
};

const PRESSED_CONTAINER: Record<Variant, object> = {
  primary: { backgroundColor: colors.actionPressed },
  secondary: { backgroundColor: colors.brown[700] },
  outline: { backgroundColor: colors.surfaceMuted },
};

const VARIANT_LABEL: Record<Variant, object> = {
  primary: { color: colors.onAction },
  secondary: { color: colors.onDark },
  outline: { color: colors.textPrimary },
};
