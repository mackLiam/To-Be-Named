import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { colors, spacing } from '../theme/tokens';
import { Body } from './Body';
import { Button } from './Button';
import { Heading } from './Heading';

/**
 * The three non-content states every data screen has, drawn the same way
 * everywhere. Pick which one with listView() in src/lib/uiState.ts.
 */

/** Spinner plus the words, so a slow network never looks like a blank page. */
export function LoadingState({ label }: { label: string }) {
  return (
    <View
      style={styles.loading}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityState={{ busy: true }}
    >
      <ActivityIndicator color={colors.textPrimary} />
      <Body color={colors.textSecondary}>{label}</Body>
    </View>
  );
}

/**
 * Failure block: oxblood rule plus words that say it failed (color is never
 * the only signal), and a button to retry. Pull-to-refresh does not exist on
 * web, so a retry is always a visible button, never only a gesture.
 */
export function ErrorState({
  title,
  line,
  onRetry,
  retryLabel = 'Try again',
}: {
  title: string;
  line?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <View style={styles.error} accessibilityLiveRegion="polite" role="alert">
      <View style={styles.errorText}>
        <Body variant="bodyStrong" color={colors.danger}>
          {title}
        </Body>
        {line ? <Body color={colors.textPrimary}>{line}</Body> : null}
      </View>
      {onRetry && (
        <Button variant="outline" onPress={onRetry}>
          {retryLabel}
        </Button>
      )}
    </View>
  );
}

/** Nothing here yet: a plain heading, at most one line, at most one action. */
export function EmptyState({
  title,
  line,
  action,
}: {
  title: string;
  line?: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.empty}>
      <Heading level="h2">{title}</Heading>
      {line ? <Body color={colors.textSecondary}>{line}</Body> : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.lg,
  },
  error: {
    gap: spacing.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
    paddingLeft: spacing.md,
    paddingVertical: spacing.xs,
    marginBottom: spacing.lg,
  },
  errorText: { gap: spacing.xs },
  empty: { gap: spacing.sm, paddingTop: spacing.md, paddingBottom: spacing.lg },
  emptyAction: { marginTop: spacing.md },
});
