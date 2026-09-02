/**
 * Public type surface for the Zells capture native module.
 *
 * The module wraps Apple's ObjectCaptureSession (guided photo capture) and
 * PhotogrammetrySession (on-device 3D reconstruction). See docs/DESIGN.md
 * section 5 and CLAUDE.md gotcha 3. These types are the contract between the
 * Swift side (apps/app/modules/zells-capture/ios) and the JS wrapper
 * (index.ts); keep them in sync with the Swift Records and Events.
 */

import type { EventSubscription } from 'expo-modules-core';

/**
 * Reconstruction detail level, mapped 1:1 to
 * PhotogrammetrySession.Request.Detail on the Swift side.
 *
 * iOS ships exactly one case, `.reduced` (RealityFoundation.swiftinterface,
 * iOS 26.5 SDK); medium/full/raw are macOS-only. This is not a limitation
 * worth papering over: the measurement pipeline only needs enough fidelity for
 * the 25-variable schema (Leg_Length + 4 slices x 6 dims), not a hero render.
 * Widen this union only when a platform actually offers another level.
 */
export type DetailLevel = 'reduced';

/**
 * Lifecycle states surfaced from the guided ObjectCaptureSession. These mirror
 * the states the SwiftUI capture flow can be in and drive UI copy ("walk
 * around the leg", "finishing", etc.). Not every state maps 1:1 to an Apple
 * enum case; the Swift side normalizes into this set.
 */
export type CaptureState =
  | 'initializing'
  | 'ready'
  | 'detecting'
  | 'capturing'
  | 'finishing'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** Options for {@link ReconstructOptions.detail}. */
export interface ReconstructOptions {
  /** Reconstruction fidelity. Defaults to 'reduced' on the Swift side. */
  detail?: DetailLevel;
  /**
   * Absolute path to the session directory returned by startCapture. If
   * omitted, the Swift side uses the most recent capture session it created.
   */
  sessionDir?: string;
}

/** Result of a completed guided capture. All paths are inside the app sandbox. */
export interface CaptureResult {
  /** Opaque id for this capture session (also the on-disk folder name). */
  sessionId: string;
  /** Absolute path to the directory holding the captured images. */
  imageDir: string;
  /** Number of images collected. */
  imageCount: number;
}

/** Result of a completed reconstruction. All paths are inside the app sandbox. */
export interface ReconstructResult {
  /** Session this reconstruction belongs to. */
  sessionId: string;
  /** Absolute path to the reconstructed USDZ (Apple-native output). */
  usdzPath: string;
  /**
   * Absolute path to the OBJ converted from the USDZ. The Python pipeline
   * consumes OBJ/PLY/GLB, not USDZ (CLAUDE.md gotcha 4), so this is the file
   * the upload step should send.
   */
  objPath: string;
  /** Detail level actually used. */
  detail: DetailLevel;
  /** Number of source images fed to the reconstruction. */
  imageCount: number;
}

/** Payload for the 'onCaptureStateChange' event. */
export interface CaptureStateEvent {
  state: CaptureState;
  /** Optional human-readable detail for logging / debugging. */
  message?: string;
}

/** Payload for the 'onReconstructionProgress' event. */
export interface ReconstructionProgressEvent {
  /** 0..1 completion fraction reported by PhotogrammetrySession. */
  fraction: number;
  /** Optional coarse stage label (e.g. 'processing', 'optimizing'). */
  stage?: string;
}

/** Event name -> payload map, used to type the event subscription helpers. */
export interface CaptureEventsMap {
  onCaptureStateChange: CaptureStateEvent;
  onReconstructionProgress: ReconstructionProgressEvent;
}

export type CaptureEventName = keyof CaptureEventsMap;

/**
 * Shape of the native module as exposed by expo-modules-core. Only present on a
 * capable iOS build (custom dev client / EAS); null everywhere else. The JS
 * wrapper in index.ts is the only place that should touch this directly.
 */
export interface ZellsCaptureNativeModule {
  /**
   * Whether ObjectCaptureSession.isSupported on this device (LiDAR + iOS 17+).
   * Async because the SDK property is main-actor isolated, so the Swift side
   * has to hop to the main actor to read it. This is the app's LiDAR truth
   * source.
   */
  isSupported(): Promise<boolean>;
  startCapture(): Promise<CaptureResult>;
  reconstruct(options: ReconstructOptions): Promise<ReconstructResult>;
  cancel(): Promise<void>;
  /** Inherited from the Expo NativeModule/EventEmitter base. */
  addListener<E extends CaptureEventName>(
    eventName: E,
    listener: (payload: CaptureEventsMap[E]) => void,
  ): EventSubscription;
}
