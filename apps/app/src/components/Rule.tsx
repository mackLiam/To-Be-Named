import { StyleSheet, View } from 'react-native';

import { colors, spacing } from '../theme/tokens';

/** A hairline rule. Elevation and separation come from rules and color
 * blocks, not soft drop shadows (banned look #5). */
export function Rule() {
  return <View style={styles.rule} />;
}

const styles = StyleSheet.create({
  rule: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.md,
  },
});
