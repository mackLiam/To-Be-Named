/**
 * App-facing capture availability check.
 *
 * Combines three layers into one answer for screens (capture-info.tsx and the
 * scan tab) to consume:
 *   1. Platform policy - isCaptureSupported (src/lib/capture.ts): iOS-only.
 *   2. Native truth - the module's isSupported(): ObjectCaptureSession +
 *      LiDAR + iOS 17 actually available on this device.
 *
 * Screen wiring is a later task; this is the seam it will call.
 */

import { Platform } from 'react-native';

import { isSupported as nativeIsSupported } from '../../modules/zells-capture';
import { isCaptureSupported } from './capture';

export interface CaptureAvailability {
  /** Whether the guided capture flow can run right now. */
  supported: boolean;
  /** Machine/UI-friendly reason. 'ok' when supported. */
  reason: CaptureUnavailableReason;
}

export type CaptureUnavailableReason =
  | 'ok'
  /** Not iOS (web / Android). */
  | 'platform'
  /** iOS, but no LiDAR / iOS < 17 / module not linked. */
  | 'device';

/**
 * Pure combiner: given the platform and the native isSupported result, decide
 * availability. Separated from I/O so it is unit-testable without a device.
 * Reuses isCaptureSupported for the platform gate (no duplicated logic).
 */
export function resolveCaptureAvailability(
  platform: string,
  nativeSupported: boolean,
): CaptureAvailability {
  if (!isCaptureSupported(platform)) {
    return { supported: false, reason: 'platform' };
  }
  if (!nativeSupported) {
    return { supported: false, reason: 'device' };
  }
  return { supported: true, reason: 'ok' };
}

/**
 * Resolve capture availability on the current device. Never throws: a native
 * failure or an absent module resolves to { supported: false }.
 */
export async function getCaptureAvailability(): Promise<CaptureAvailability> {
  const nativeSupported = await nativeIsSupported();
  return resolveCaptureAvailability(Platform.OS, nativeSupported);
}
