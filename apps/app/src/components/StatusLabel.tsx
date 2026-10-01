import { StyleSheet, View } from 'react-native';

import type { SessionStatus } from '../lib/library';
import { colors, spacing } from '../theme/tokens';
import { Body } from './Body';

export type StatusTone = 'action' | 'danger' | 'muted';

/** Brick 600 only where the user can act now; oxblood only for failure. */
export const SESSION_TONE: Record<SessionStatus, StatusTone> = {
  ready: 'action',
  processing: 'muted',
  needs_rescan: 'danger',
  one_leg: 'muted',
};

const TONE_COLOR: Record<StatusTone, string> = {
  action: colors.action,
  danger: colors.danger,
  muted: colors.textSecondary,
};

/** Small uppercase status with a square marker. The words carry the state; color only repeats it. */
export function StatusLabel({ label, tone = 'muted' }: { label: string; tone?: StatusTone }) {
  const color = TONE_COLOR[tone];
  return (
    <View style={styles.row}>
      <View style={[styles.mark, { backgroundColor: color }]} />
      <Body variant="label" color={color}>
        {label}
      </Body>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  mark: { width: 8, height: 8 },
});
