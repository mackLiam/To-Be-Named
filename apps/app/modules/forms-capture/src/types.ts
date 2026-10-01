/**
 * Public type surface for the FORMS capture native module.
 *
 * The module wraps Apple's ObjectCaptureSession (guided photo capture) and
 * PhotogrammetrySession (on-device 3D reconstruction). See docs/DESIGN.md
 * section 5 and CLAUDE.md gotcha 3. These types are the contract between the
 * Swift side (apps/app/modules/forms-capture/ios) and the JS wrapper
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

/**
 * Result of a completed guided photo capture (non-LiDAR path). The bundle is
 * `${bundleDir}/capture.json` plus `${bundleDir}/images/NNN.jpg`, the
 * "forms.photo-capture" v1 contract validated in src/lib/upload.ts. All paths
 * are inside the app sandbox; reconstruction happens server-side.
 */
export interface PhotoCaptureResult {
  /** Opaque id for this capture session (also the on-disk folder name). */
  sessionId: string;
  /** Absolute path to the bundle directory. */
  bundleDir: string;
  /** Absolute path to capture.json. */
  manifestPath: string;
  /** Number of photos kept. */
  imageCount: number;
  /** Fraction (0..1) of the 36 ten-degree orbit buckets that hold a photo. */
  coverage: number;
  /** Who held the phone; decides the coverage requirement. */
  mode: PhotoCaptureMode;
  /** True when the user finished before the mode's requirement was met. */
  finishedEarly: boolean;
}

/**
 * 'solo': the person scans their own leg, sweeping an arc they can reach
 * (needs 50% coverage including front, inner and outer). 'helper': someone
 * else walks a full circle (needs 85%).
 */
export type PhotoCaptureMode = 'solo' | 'helper';

export interface PhotoCaptureOptions {
  mode: PhotoCaptureMode;
}

/** Frame rejection reasons counted in {@link PhotoCaptureStatsEvent.rejected}. */
export type PhotoRejectReason =
  'trackingLimited' | 'tooDark' | 'movingTooFast' | 'blurry' | 'tooClose' | 'tooFar' | 'offTarget';

/**
 * Payload for 'onPhotoCaptureStats', emitted once a second during photo
 * capture for tuning. Scalars only: never images, poses or positions.
 */
export interface PhotoCaptureStatsEvent {
  kept: number;
  rejected: Partial<Record<PhotoRejectReason, number>>;
  /** 0..1, same measure as PhotoCaptureResult.coverage. */
  coverage: number;
  /** Horizontal camera to leg axis distance; null before the aim tap. */
  distanceM: number | null;
  /** ARKit ambientIntensity (lumens, ~1000 is a lit room); null if unknown. */
  ambientIntensity: number | null;
  mode: PhotoCaptureMode;
  aimed: boolean;
}

/**
 * Solo silhouette stations around the leg axis, relative to the aim (front)
 * azimuth: front 0, front_inner and front_outer at 45 degrees, inner and outer
 * at 90 degrees. capture.json v2 "station" values.
 */
export type SilhouetteStation = 'front' | 'front_inner' | 'inner' | 'front_outer' | 'outer';

export interface SilhouetteCaptureOptions {
  /** Which leg; decides which side of the front is inner. */
  leg: 'L' | 'R';
}

/**
 * Result of a completed solo silhouette capture. The bundle is
 * `${bundleDir}/capture.json` plus `images/NNN.jpg` and `masks/NNN.png`, the
 * "forms.photo-capture" v2 contract (method "silhouette") validated in
 * src/lib/upload.ts.
 */
export interface SilhouetteCaptureResult {
  method: 'silhouette';
  sessionId: string;
  bundleDir: string;
  manifestPath: string;
  /** Stations captured (4 or 5). */
  imageCount: number;
  /** Stations captured / 5. */
  coverage: number;
  mode: 'solo';
  /** True when finished with 4 stations. */
  finishedEarly: boolean;
  /** Whether a floor plane was found (capture.json floor_y is not null). */
  floorFound: boolean;
}

/** Auto-capture conditions counted in {@link SilhouetteStatsEvent.failures}. */
export type SilhouetteCondition =
  'tracking' | 'spot' | 'distance' | 'level' | 'still' | 'mask' | 'blur';

/**
 * Payload for 'onSilhouetteStats', emitted once a second during silhouette
 * capture for tuning. Scalars only: never images, masks, poses or positions.
 */
export interface SilhouetteStatsEvent {
  stationsCaptured: number;
  currentStation: SilhouetteStation | null;
  /** Signed camera azimuth minus the current station's azimuth; null before the aim. */
  azimuthOffsetDeg: number | null;
  distanceM: number | null;
  /** Optical axis angle from horizontal. */
  levelDeg: number | null;
  maskValid: boolean;
  floorFound: boolean;
  /** Evaluation ticks each condition failed, cumulative. */
  failures: Partial<Record<SilhouetteCondition, number>>;
  torchOn: boolean;
  ambientIntensity: number | null;
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
  onPhotoCaptureStats: PhotoCaptureStatsEvent;
  onSilhouetteStats: SilhouetteStatsEvent;
}

export type CaptureEventName = keyof CaptureEventsMap;

/**
 * Shape of the native module as exposed by expo-modules-core. Only present on a
 * capable iOS build (custom dev client / EAS); null everywhere else. The JS
 * wrapper in index.ts is the only place that should touch this directly.
 */
export interface FormsCaptureNativeModule {
  /**
   * Whether ObjectCaptureSession.isSupported on this device (LiDAR + iOS 17+).
   * Async because the SDK property is main-actor isolated, so the Swift side
   * has to hop to the main actor to read it. This is the app's LiDAR truth
   * source.
   */
  isSupported(): Promise<boolean>;
  startCapture(): Promise<CaptureResult>;
  /** ARWorldTrackingConfiguration.isSupported: any ARKit iPhone, no LiDAR. */
  isPhotoCaptureSupported(): Promise<boolean>;
  startPhotoCapture(options: PhotoCaptureOptions): Promise<PhotoCaptureResult>;
  /** Solo silhouette capture (any ARKit iPhone, iOS 17+ Vision masks). */
  startSilhouetteCapture(options: SilhouetteCaptureOptions): Promise<SilhouetteCaptureResult>;
  reconstruct(options: ReconstructOptions): Promise<ReconstructResult>;
  cancel(): Promise<void>;
  /** Inherited from the Expo NativeModule/EventEmitter base. */
  addListener<E extends CaptureEventName>(
    eventName: E,
    listener: (payload: CaptureEventsMap[E]) => void,
  ): EventSubscription;
}
