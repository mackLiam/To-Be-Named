import { View } from 'react-native';

import { Body } from '../src/components/Body';
import { Heading } from '../src/components/Heading';
import { Rule } from '../src/components/Rule';
import { Screen } from '../src/components/Screen';
import { spacing } from '../src/theme/tokens';

/**
 * Capture entry point stub. The real screen replaces this once the Swift
 * native module (config plugin wrapping ObjectCaptureSession /
 * PhotogrammetrySession) ships and is built into a dev client via EAS.
 *
 * TODO(capture): wire this screen to the native module once it exists.
 * It cannot be tested in Expo Go, only in an EAS dev-client build, on a
 * physical LiDAR iPhone. See docs/DESIGN.md section 5 ("Platform Strategy")
 * and CLAUDE.md gotcha 3.
 */
export default function CaptureInfoScreen() {
  return (
    <Screen>
      <Heading level="h1">Capture ships with the dev build.</Heading>
      <View style={{ height: spacing.md }} />
      <Body>
        The guided scan uses Apple&apos;s ObjectCaptureSession through a native module built
        specifically for Zells. It only runs inside the Zells dev client (an EAS build), never
        inside Expo Go, and never in this placeholder screen yet.
      </Body>
      <Rule />
      <Heading level="h3">What happens here later</Heading>
      <View style={{ height: spacing.sm }} />
      <Body variant="bodySmall">
        This screen becomes the guided capture flow: walk around your leg once, the native module
        reconstructs a 3D mesh on-device, and it uploads to your scan library automatically. No
        manual export step, no separate app.
      </Body>
    </Screen>
  );
}
