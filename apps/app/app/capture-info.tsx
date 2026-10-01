import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Body } from '../src/components/Body';
import { Button } from '../src/components/Button';
import { Heading } from '../src/components/Heading';
import { Screen } from '../src/components/Screen';
import { UnavailableNotice } from '../src/components/UnavailableNotice';
import { getCaptureAvailability } from '../src/lib/nativeCapture';
import type { CaptureAvailability } from '../src/lib/nativeCapture';
import { colors, spacing } from '../src/theme/tokens';

/**
 * Pre-capture checklist and the availability gate in front of the guided
 * flow (app/capture.tsx): a supported device gets Start, an unsupported one
 * gets the reason. Capture only runs in the custom dev client on a LiDAR
 * iPhone, never in Expo Go (root CLAUDE.md gotcha 3).
 */
export default function CaptureInfoScreen() {
  const router = useRouter();
  const [availability, setAvailability] = useState<CaptureAvailability | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCaptureAvailability().then((result) => {
      if (!cancelled) {
        setAvailability(result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (availability === null) {
    return (
      <Screen>
        <ActivityIndicator color={colors.textPrimary} accessibilityLabel="Checking this phone" />
      </Screen>
    );
  }

  if (!availability.supported) {
    return (
      <Screen
        footer={
          <Button variant="outline" onPress={router.back}>
            Back
          </Button>
        }
      >
        <UnavailableNotice reason={availability.reason} />
      </Screen>
    );
  }

  const tips = [
    'Shorts on, or trousers rolled above the knee.',
    availability.mode === 'photos'
      ? 'Good light, and a patterned sock or a few pen dots on the shin.'
      : 'Even light, no harsh shadows.',
    availability.mode === 'photos'
      ? 'A chair to sit on, or someone to walk a circle around you.'
      : 'Room to walk one slow circle around your leg.',
  ];

  return (
    <Screen footer={<Button onPress={() => router.push('/capture')}>Start</Button>}>
      <Heading level="display">Before you start</Heading>
      <View style={styles.tips}>
        {tips.map((tip, i) => (
          <View key={tip} style={styles.tip}>
            <Heading level="h2" color={colors.action} style={styles.num}>
              {i + 1}
            </Heading>
            <Body variant="bodyStrong" style={styles.tipText}>
              {tip}
            </Body>
          </View>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  tips: { marginTop: spacing.xl, gap: spacing.lg },
  tip: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.md },
  num: { width: spacing.lg },
  tipText: { flex: 1 },
});
