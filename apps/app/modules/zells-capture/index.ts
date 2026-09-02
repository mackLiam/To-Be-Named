/**
 * Zells capture module - public JS API.
 *
 * Thin, safe wrapper over the Swift native module. Every function works on
 * every platform: where the native module is absent, isSupported() resolves
 * false and the action functions reject with a typed CaptureUnavailableError,
 * so importing or calling this module never crashes on web, Android, the iOS
 * Simulator, or Expo Go (CLAUDE.md gotcha 3).
 *
 * Sensitive-data note (CLAUDE.md gotcha 5): captured images and reconstructed
 * meshes are body scans of (often) minors. The native side keeps every file
 * inside the app sandbox; this module never uploads, and adds no network or
 * analytics calls.
 */

import type { EventSubscription } from 'expo-modules-core';

import { CaptureUnavailableError, mapNativeError } from './src/errors';
import { ZellsCaptureNative } from './src/native';
import type {
  CaptureResult,
  CaptureStateEvent,
  ReconstructOptions,
  ReconstructResult,
  ReconstructionProgressEvent,
} from './src/types';

export { CaptureError, CaptureUnavailableError, mapNativeError } from './src/errors';
export type { CaptureErrorCode } from './src/errors';
export type {
  CaptureEventName,
  CaptureEventsMap,
  CaptureResult,
  CaptureState,
  CaptureStateEvent,
  DetailLevel,
  ReconstructOptions,
  ReconstructResult,
  ReconstructionProgressEvent,
  ZellsCaptureNativeModule,
} from './src/types';

/** True when the native module is linked into the running binary. */
export function isNativeModuleAvailable(): boolean {
  return ZellsCaptureNative != null;
}

/**
 * Whether this device can run guided capture: ObjectCaptureSession.isSupported
 * (LiDAR + iOS 17+). Resolves false wherever the native module is absent. This
 * is the app's authoritative LiDAR check; higher-level gating in
 * src/lib/nativeCapture.ts layers Platform + policy on top of it.
 */
export async function isSupported(): Promise<boolean> {
  if (!ZellsCaptureNative) {
    return false;
  }
  try {
    // Native side is an AsyncFunction (the SDK property is main-actor
    // isolated); any bridge error collapses into a plain false.
    return Boolean(await ZellsCaptureNative.isSupported());
  } catch {
    return false;
  }
}

/**
 * Present Apple's guided ObjectCaptureSession flow and collect images into a
 * session directory in the app sandbox. Resolves once the user finishes the
 * guided capture; rejects with ERR_CAPTURE_CANCELLED if they back out.
 */
export async function startCapture(): Promise<CaptureResult> {
  if (!ZellsCaptureNative) {
    throw new CaptureUnavailableError(
      'Guided capture is unavailable on this device (native module not linked).',
    );
  }
  try {
    return await ZellsCaptureNative.startCapture();
  } catch (error) {
    throw mapNativeError(error);
  }
}

/**
 * Run PhotogrammetrySession over the captured images and return both the USDZ
 * and the OBJ converted from it (the OBJ is what the Python pipeline consumes).
 * Subscribe to progress via {@link addReconstructionProgressListener}.
 */
export async function reconstruct(options: ReconstructOptions = {}): Promise<ReconstructResult> {
  if (!ZellsCaptureNative) {
    throw new CaptureUnavailableError(
      'Reconstruction is unavailable on this device (native module not linked).',
    );
  }
  try {
    return await ZellsCaptureNative.reconstruct(options);
  } catch (error) {
    throw mapNativeError(error);
  }
}

/**
 * Cancel an in-flight capture or reconstruction. No-op (resolves) where the
 * native module is absent, since there is nothing to cancel.
 */
export async function cancel(): Promise<void> {
  if (!ZellsCaptureNative) {
    return;
  }
  try {
    await ZellsCaptureNative.cancel();
  } catch (error) {
    throw mapNativeError(error);
  }
}

/** A subscription that removes nothing; returned when the module is absent. */
const NOOP_SUBSCRIPTION: EventSubscription = { remove() {} };

/** Subscribe to guided-capture state changes. */
export function addCaptureStateListener(
  listener: (event: CaptureStateEvent) => void,
): EventSubscription {
  if (!ZellsCaptureNative) {
    return NOOP_SUBSCRIPTION;
  }
  return ZellsCaptureNative.addListener('onCaptureStateChange', listener);
}

/** Subscribe to reconstruction progress (0..1). */
export function addReconstructionProgressListener(
  listener: (event: ReconstructionProgressEvent) => void,
): EventSubscription {
  if (!ZellsCaptureNative) {
    return NOOP_SUBSCRIPTION;
  }
  return ZellsCaptureNative.addListener('onReconstructionProgress', listener);
}
