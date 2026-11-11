import { View } from 'react-native';

import { BRAND_NAME } from '@forms/shared/brand';

import type { CaptureUnavailableReason } from '../lib/nativeCapture';
import { colors, spacing } from '../theme/tokens';
import { Body } from './Body';
import { Heading } from './Heading';

/** 'module' means the installed build lacks the capture module; 'device' is a hardware limit. */
const COPY: Record<Exclude<CaptureUnavailableReason, 'ok'>, { title: string; line: string }> = {
  platform: {
    title: 'Scan on your iPhone',
    line: 'Use the same email there and your scans show up here.',
  },
  module: {
    title: 'This app cannot scan',
    line: `Update ${BRAND_NAME} on this iPhone and try again.`,
  },
  // 'device' means neither LiDAR capture nor the ARKit photo capture runs
  // (nativeCapture.ts), so naming a Pro model here would be wrong: photo
  // capture covers any iPhone that runs iOS 17.
  device: {
    title: 'This iPhone cannot scan',
    line: 'Scanning needs a newer iPhone on iOS 17 or later.',
  },
};

/** Shared by capture-info and capture so an unsupported device reads the same everywhere. */
export function UnavailableNotice({ reason }: { reason: CaptureUnavailableReason | null }) {
  const copy = COPY[reason === 'platform' || reason === 'module' ? reason : 'device'];
  return (
    <View>
      <Heading level="h1">{copy.title}</Heading>
      <View style={{ height: spacing.md }} />
      <Body color={colors.textSecondary}>{copy.line}</Body>
    </View>
  );
}
