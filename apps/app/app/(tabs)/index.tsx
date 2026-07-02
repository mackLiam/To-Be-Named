import { useRouter } from 'expo-router';
import { Platform, View } from 'react-native';

import { Body } from '../../src/components/Body';
import { Button } from '../../src/components/Button';
import { Heading } from '../../src/components/Heading';
import { Rule } from '../../src/components/Rule';
import { Screen } from '../../src/components/Screen';
import { isCaptureSupported } from '../../src/lib/capture';
import { colors, spacing } from '../../src/theme/tokens';

const DEVICE_REQUIREMENTS = [
  'iPhone 12 Pro or later Pro model (LiDAR sensor required)',
  'iOS 17 or later',
  'A dev-build install of Zells, not the App Store build yet (Phase 0)',
];

export default function ScanScreen() {
  const router = useRouter();
  // hasLiDAR is unknown until the native capture module ships and can query
  // the device (see src/lib/capture.ts). Passing undefined here means: show
  // the entry point on any iPhone for now, and tighten this once the module
  // can positively confirm or rule out LiDAR.
  const canCapture = isCaptureSupported(Platform.OS);

  if (!canCapture) {
    return (
      <Screen>
        <Heading level="display">Scan on your iPhone.</Heading>
        <View style={{ height: spacing.md }} />
        <Body>
          It appears here. Capture only runs on a LiDAR iPhone right now, your scan library, orders,
          and shop work the same on every device once a scan exists.
        </Body>
        <Rule />
        <Heading level="h3">Why iPhone only</Heading>
        <View style={{ height: spacing.sm }} />
        <Body color={colors.textSecondary} variant="bodySmall">
          The guard is built from a 3D reconstruction of your leg, captured with Apple&apos;s LiDAR
          scanner. Android and browser capture are on the roadmap (see docs/DESIGN.md section 5):
          they will land as a photo-upload path once the server-side reconstruction worker ships.
        </Body>
      </Screen>
    );
  }

  return (
    <Screen>
      <Heading level="display">Scan your leg.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>
        Ten minutes with your phone gets you a guard molded to your leg, not off a shelf. Walk
        around it once, we take it from there.
      </Body>
      <View style={{ height: spacing.lg }} />
      <Button onPress={() => router.push('/capture-info')}>Start a scan</Button>
      <Rule />
      <Heading level="h3">Before you start</Heading>
      <View style={{ height: spacing.sm }} />
      {DEVICE_REQUIREMENTS.map((requirement) => (
        <View key={requirement} style={{ flexDirection: 'row', marginBottom: spacing.xs }}>
          <Body color={colors.textSecondary} variant="bodySmall">
            {'- '}
          </Body>
          <Body color={colors.textSecondary} variant="bodySmall" style={{ flex: 1 }}>
            {requirement}
          </Body>
        </View>
      ))}
    </Screen>
  );
}
