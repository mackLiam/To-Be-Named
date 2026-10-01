/**
 * FORMS capture module - public JS API.
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
import { FormsCaptureNative } from './src/native';
import type {
  CaptureResult,
  CaptureStateEvent,
  PhotoCaptureOptions,
  PhotoCaptureResult,
  PhotoCaptureStatsEvent,
  ReconstructOptions,
  ReconstructResult,
  ReconstructionProgressEvent,
  SilhouetteCaptureOptions,
  SilhouetteCaptureResult,
  SilhouetteStatsEvent,
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
  PhotoCaptureMode,
  PhotoCaptureOptions,
  PhotoCaptureResult,
  PhotoCaptureStatsEvent,
  PhotoRejectReason,
  ReconstructOptions,
  ReconstructResult,
  ReconstructionProgressEvent,
  FormsCaptureNativeModule,
  SilhouetteCaptureOptions,
  SilhouetteCaptureResult,
  SilhouetteCondition,
  SilhouetteStation,
  SilhouetteStatsEvent,
} from './src/types';

/** True when the native module is linked into the running binary. */
export function isNativeModuleAvailable(): boolean {
  return FormsCaptureNative != null;
}

/**
 * Whether this device can run guided capture: ObjectCaptureSession.isSupported
 * (LiDAR + iOS 17+). Resolves false wherever the native module is absent. This
 * is the app's authoritative LiDAR check; higher-level gating in
 * src/lib/nativeCapture.ts layers Platform + policy on top of it.
 */
export async function isSupported(): Promise<boolean> {
  if (!FormsCaptureNative) {
    return false;
  }
  try {
    // Native side is an AsyncFunction (the SDK property is main-actor
    // isolated); any bridge error collapses into a plain false.
    return Boolean(await FormsCaptureNative.isSupported());
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
  if (!FormsCaptureNative) {
    throw new CaptureUnavailableError(
      'Guided capture is unavailable on this device (native module not linked).',
    );
  }
  try {
    return await FormsCaptureNative.startCapture();
  } catch (error) {
    throw mapNativeError(error);
  }
}

/**
 * Whether this device can run guided photo capture (ARKit world tracking, any
 * modern iPhone, no LiDAR). Resolves false wherever the native module is absent.
 */
export async function isPhotoCaptureSupported(): Promise<boolean> {
  if (!FormsCaptureNative) {
    return false;
  }
  try {
    return Boolean(await FormsCaptureNative.isPhotoCaptureSupported());
  } catch {
    return false;
  }
}

/**
 * Present guided photo capture and write a capture.json + images bundle into
 * the app sandbox. Resolves on Done; rejects with ERR_CAPTURE_CANCELLED on
 * Cancel. No on-device reconstruction: the bundle is uploaded as-is.
 */
export async function startPhotoCapture(
  options: PhotoCaptureOptions = { mode: 'solo' },
): Promise<PhotoCaptureResult> {
  if (!FormsCaptureNative) {
    throw new CaptureUnavailableError(
      'Photo capture is unavailable on this device (native module not linked).',
    );
  }
  try {
    return await FormsCaptureNative.startPhotoCapture(options);
  } catch (error) {
    throw mapNativeError(error);
  }
}

/**
 * Present solo silhouette capture (five still photos with on-device leg
 * masks) and write a capture.json v2 bundle into the app sandbox. Resolves on
 * Done; rejects with ERR_CAPTURE_CANCELLED on Cancel and with
 * ERR_CAPTURE_SWITCH_TO_MANUAL when the user picks hand measurement.
 */
export async function startSilhouetteCapture(
  options: SilhouetteCaptureOptions,
): Promise<SilhouetteCaptureResult> {
  if (!FormsCaptureNative) {
    throw new CaptureUnavailableError(
      'Silhouette capture is unavailable on this device (native module not linked).',
    );
  }
  try {
    return await FormsCaptureNative.startSilhouetteCapture(options);
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
  if (!FormsCaptureNative) {
    throw new CaptureUnavailableError(
      'Reconstruction is unavailable on this device (native module not linked).',
    );
  }
  try {
    return await FormsCaptureNative.reconstruct(options);
  } catch (error) {
    throw mapNativeError(error);
  }
}

/**
 * Cancel an in-flight capture or reconstruction. No-op (resolves) where the
 * native module is absent, since there is nothing to cancel.
 */
export async function cancel(): Promise<void> {
  if (!FormsCaptureNative) {
    return;
  }
  try {
    await FormsCaptureNative.cancel();
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
  if (!FormsCaptureNative) {
    return NOOP_SUBSCRIPTION;
  }
  return FormsCaptureNative.addListener('onCaptureStateChange', listener);
}

/** Subscribe to reconstruction progress (0..1). */
export function addReconstructionProgressListener(
  listener: (event: ReconstructionProgressEvent) => void,
): EventSubscription {
  if (!FormsCaptureNative) {
    return NOOP_SUBSCRIPTION;
  }
  return FormsCaptureNative.addListener('onReconstructionProgress', listener);
}

/** Subscribe to once-a-second photo capture diagnostics (tuning only). */
export function addPhotoCaptureStatsListener(
  listener: (event: PhotoCaptureStatsEvent) => void,
): EventSubscription {
  if (!FormsCaptureNative) {
    return NOOP_SUBSCRIPTION;
  }
  return FormsCaptureNative.addListener('onPhotoCaptureStats', listener);
}

/** Subscribe to once-a-second silhouette capture diagnostics (tuning only). */
export function addSilhouetteStatsListener(
  listener: (event: SilhouetteStatsEvent) => void,
): EventSubscription {
  if (!FormsCaptureNative) {
    return NOOP_SUBSCRIPTION;
  }
  return FormsCaptureNative.addListener('onSilhouetteStats', listener);
}
