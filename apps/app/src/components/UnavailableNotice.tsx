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
    line: 'Scanning needs an iPhone Pro with LiDAR. Your scans show up here.',
  },
  module: {
    title: 'This app cannot scan',
    line: `Update ${BRAND_NAME} on this iPhone and try again.`,
  },
  device: {
    title: 'This iPhone cannot scan',
    line: 'Scanning needs an iPhone 12 Pro or later Pro model on iOS 17 or later.',
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
