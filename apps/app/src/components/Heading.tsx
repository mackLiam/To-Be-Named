import type { PropsWithChildren } from 'react';
import { Text, type TextStyle } from 'react-native';

import { colors, typography } from '../theme/tokens';

type Level = 'display' | 'h1' | 'h2' | 'h3';

interface HeadingProps extends PropsWithChildren {
  level?: Level;
  color?: string;
  style?: TextStyle;
}

const LEVEL_STYLES: Record<Level, TextStyle> = {
  display: typography.display,
  h1: typography.h1,
  h2: typography.h2,
  h3: typography.h3,
};

/**
 * Outfit headings at real display sizes. Big jumps between levels are baked
 * into tokens.typography - never override fontSize inline.
 */
export function Heading({
  level = 'h1',
  color = colors.textPrimary,
  children,
  style,
}: HeadingProps) {
  return <Text style={[LEVEL_STYLES[level], { color }, style]}>{children}</Text>;
}
