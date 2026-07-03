/**
 * The single point where the JS side reaches for the autolinked native module.
 *
 * `requireOptionalNativeModule` returns the native module when it is present in
 * the running binary and `null` otherwise (web, Android, iOS Simulator without
 * the module compiled in, Expo Go). Isolating this here means:
 *   - the rest of the wrapper (index.ts) is a pure function of this value, and
 *   - tests can `vi.mock('./native')` to exercise both the present and absent
 *     paths without needing a native runtime.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

import type { ZellsCaptureNativeModule } from './types';

/** The native module, or null on any platform/build without it linked. */
export const ZellsCaptureNative =
  requireOptionalNativeModule<ZellsCaptureNativeModule>('ZellsCapture');
