import { Feather } from '@expo/vector-icons';
import { Children, type PropsWithChildren, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors, radius, spacing, typography } from '../theme/tokens';
import { Body } from './Body';

interface ListGroupProps extends PropsWithChildren {
  /** Small label above the group. */
  title?: string;
  /** One short caption under the group. */
  footnote?: string;
}

/** Grouped settings-style rows: a flat muted block, hairlines between rows, no shadow. */
export function ListGroup({ title, footnote, children }: ListGroupProps) {
  const rows = Children.toArray(children);
  return (
    <View style={styles.wrap}>
      {title && (
        <Body variant="label" color={colors.textSecondary} style={styles.title}>
          {title}
        </Body>
      )}
      <View style={styles.group}>
        {rows.map((row, i) => (
          <View key={i} style={i > 0 && styles.divider}>
            {row}
          </View>
        ))}
      </View>
      {footnote && (
        <Body variant="caption" color={colors.textSecondary} style={styles.footnote}>
          {footnote}
        </Body>
      )}
    </View>
  );
}

interface ListRowProps {
  label: string;
  /** Right-aligned value, e.g. a status or a price. */
  value?: string;
  /** Second line under the label. */
  detail?: string;
  onPress?: () => void;
  /** 'danger' for destructive rows; the label still says what it does. */
  tone?: 'default' | 'danger';
  /** Chevron glyph; defaults to chevron-right when the row is tappable. */
  icon?: keyof typeof Feather.glyphMap | null;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: 'button' | 'link';
  accessibilityState?: { expanded?: boolean };
  /** Extra content under the row (e.g. an inline confirm). */
  children?: ReactNode;
}

export function ListRow({
  label,
  value,
  detail,
  onPress,
  tone = 'default',
  icon,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
  accessibilityState,
  children,
}: ListRowProps) {
  const color = tone === 'danger' ? colors.danger : colors.textPrimary;
  const glyph = icon === undefined ? (onPress ? 'chevron-right' : null) : icon;
  const content = (
    <>
      <View style={styles.text}>
        <Body style={{ ...typography.button, color }}>{label}</Body>
        {detail && (
          <Body variant="bodySmall" color={colors.textSecondary}>
            {detail}
          </Body>
        )}
      </View>
      {value && (
        <Body variant="bodySmall" color={colors.textSecondary} style={styles.value}>
          {value}
        </Body>
      )}
      {glyph && <Feather name={glyph} size={20} color={colors.textSecondary} />}
    </>
  );
  return (
    <View>
      {onPress ? (
        <Pressable
          onPress={onPress}
          disabled={disabled}
          accessibilityRole={accessibilityRole}
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={accessibilityHint}
          accessibilityState={{ disabled, ...accessibilityState }}
          style={({ pressed }) => [styles.row, pressed && styles.pressed, disabled && styles.dim]}
        >
          {content}
        </Pressable>
      ) : (
        <View style={styles.row} accessible accessibilityLabel={accessibilityLabel}>
          {content}
        </View>
      )}
      {children && <View style={styles.extra}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.xl },
  title: { marginBottom: spacing.sm, marginLeft: spacing.md },
  group: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius,
    overflow: 'hidden',
  },
  divider: { borderTopWidth: 1, borderTopColor: colors.border },
  footnote: { marginTop: spacing.sm, marginHorizontal: spacing.md },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
  },
  pressed: { backgroundColor: colors.border },
  dim: { opacity: 0.4 },
  text: { flex: 1, gap: spacing.xs },
  value: { flexShrink: 1, textAlign: 'right' },
  extra: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
});
