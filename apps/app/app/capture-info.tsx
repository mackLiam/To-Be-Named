import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Body } from '../src/components/Body';
import { Button } from '../src/components/Button';
import { Heading } from '../src/components/Heading';
import { Rule } from '../src/components/Rule';
import { Screen } from '../src/components/Screen';
import { getCaptureAvailability } from '../src/lib/nativeCapture';
import type { CaptureAvailability } from '../src/lib/nativeCapture';
import { colors, spacing } from '../src/theme/tokens';

/**
 * Pre-capture info screen and the availability gate in front of the guided
 * flow (app/capture.tsx). Runs getCaptureAvailability() on mount: a supported
 * device gets the start button, an unsupported one gets the reason. Capture
 * itself still only runs inside the Zells dev client on a physical LiDAR
 * iPhone, never in Expo Go (CLAUDE.md gotcha 3, docs/DESIGN.md section 5).
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

  return (
    <Screen>
      <Heading level="h1">Capture ships with the dev build.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>
        The guided scan uses Apple&apos;s ObjectCaptureSession through a native module built
        specifically for Zells. It only runs inside the Zells dev client (an EAS build), never
        inside Expo Go.
      </Body>
      <Rule />
      {availability === null && (
        <Body variant="bodySmall" color={colors.textSecondary}>
          Checking this device for capture support...
        </Body>
      )}
      {availability?.supported && (
        <>
          <Heading level="h3">This device is ready</Heading>
          <View style={{ height: spacing.sm }} />
          <Body variant="bodySmall">
            Give yourself room to walk a full circle around the leg, then start the guided capture.
          </Body>
          <View style={{ height: spacing.md }} />
          <Button onPress={() => router.push('/capture')}>Start capture</Button>
        </>
      )}
      {availability !== null && !availability.supported && (
        <>
          <Heading level="h3">This device cannot capture</Heading>
          <View style={{ height: spacing.sm }} />
          <Body variant="bodySmall">
            {availability.reason === 'platform'
              ? 'Guided capture runs on iPhone only. Open Zells on a LiDAR iPhone (12 Pro or later Pro model) to scan; everything else works here.'
              : 'This iPhone or build cannot run guided capture. It needs a LiDAR sensor, iOS 17 or later, and the Zells dev build.'}
          </Body>
          <View style={{ height: spacing.sm }} />
          <Body variant="caption" color={colors.textTertiary}>
            Reason code: {availability.reason}
          </Body>
        </>
      )}
      <Rule />
      <Heading level="h3">What happens in a scan</Heading>
      <View style={{ height: spacing.sm }} />
      <Body variant="bodySmall">
        Walk around your leg once and the native module reconstructs a 3D mesh on-device. The mesh
        then uploads to your private scan library and is queued for measurement, and you land back
        in the library when it is saved.
      </Body>
    </Screen>
  );
}
