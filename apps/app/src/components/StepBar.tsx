import { StyleSheet, View } from 'react-native';

import { colors, spacing } from '../theme/tokens';
import { Body } from './Body';

/** Guided-flow position: flat segments, done in brown, current in brick 600. */
export function StepBar({ step, total }: { step: number; total: number }) {
  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${step} of ${total}`}
    >
      <View style={styles.bars}>
        {Array.from({ length: total }, (_, i) => (
          <View
            key={i}
            style={[
              styles.bar,
              {
                backgroundColor:
                  i + 1 < step
                    ? colors.textPrimary
                    : i + 1 === step
                      ? colors.action
                      : colors.border,
              },
            ]}
          />
        ))}
      </View>
      <Body variant="label" color={colors.textSecondary}>
        Step {step} of {total}
      </Body>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm, marginBottom: spacing.xl },
  bars: { flexDirection: 'row', gap: spacing.xs },
  bar: { flex: 1, height: 4 },
});
