import type { PropsWithChildren } from 'react';
import { Text, type TextStyle } from 'react-native';

import { colors, typography } from '../theme/tokens';

type Variant = 'body' | 'bodyStrong' | 'bodySmall' | 'caption' | 'label';

interface BodyProps extends PropsWithChildren {
  variant?: Variant;
  color?: string;
  style?: TextStyle;
}

const VARIANT_STYLES: Record<Variant, TextStyle> = {
  body: typography.body,
  bodyStrong: typography.bodyStrong,
  bodySmall: typography.bodySmall,
  caption: typography.caption,
  label: { ...typography.label, textTransform: 'uppercase' },
};

/** Manrope body text. `label` variant is for small uppercase eyebrows, never a pill. */
export function Body({ variant = 'body', color = colors.textPrimary, children, style }: BodyProps) {
  return <Text style={[VARIANT_STYLES[variant], { color }, style]}>{children}</Text>;
}
