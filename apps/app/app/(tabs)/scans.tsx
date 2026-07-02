import { View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Heading } from '../../src/components/Heading';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import { useScans } from '../../src/hooks/useScans';
import { colors, spacing } from '../../src/theme/tokens';

const STATUS_LABEL: Record<string, string> = {
  capturing: 'Capturing',
  uploaded: 'Uploaded',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed, rescan needed',
};

const STATUS_COLOR: Record<string, string> = {
  capturing: colors.textSecondary,
  uploaded: colors.textSecondary,
  processing: colors.textSecondary,
  ready: colors.textPrimary,
  failed: colors.danger,
};

export default function ScansScreen() {
  const { data: scans, loading, error } = useScans();

  return (
    <Screen>
      <Heading level="display">Your scan library.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>Every scan you take, kept here. A guard order reuses one, no rescan required.</Body>
      <Rule />

      {loading && <Body color={colors.textSecondary}>Loading your scans.</Body>}

      {error && (
        <Body color={colors.danger}>
          Could not load your scans right now. Pull to refresh once that is wired up, or try again
          shortly.
        </Body>
      )}

      {!loading && !error && scans.length === 0 && (
        <View>
          <Heading level="h3">No scans yet.</Heading>
          <View style={{ height: spacing.sm }} />
          <Body color={colors.textSecondary}>
            Start one from the Scan tab. It takes about ten minutes and works for both legs.
          </Body>
        </View>
      )}

      {scans.map((scan) => (
        <View key={scan.id}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Body variant="bodyStrong">{scan.leg === 'left' ? 'Left leg' : 'Right leg'}</Body>
            <Body color={STATUS_COLOR[scan.status] ?? colors.textSecondary}>
              {STATUS_LABEL[scan.status] ?? scan.status}
            </Body>
          </View>
          <Body variant="caption" color={colors.textTertiary}>
            {new Date(scan.createdAt).toLocaleDateString()}
          </Body>
          <Rule />
        </View>
      ))}
    </Screen>
  );
}
