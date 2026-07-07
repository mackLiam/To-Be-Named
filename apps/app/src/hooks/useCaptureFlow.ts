/**
 * Capture flow state machine for the guided scan screen (app/capture.tsx).
 *
 * Phases:
 *
 *   checking -> unsupported                 (availability gate says no)
 *   checking -> ready                       (availability gate says yes)
 *   ready|failed|done -> capturing          (start(): native guided UI up)
 *   capturing -> reconstructing             (startCapture resolved)
 *   capturing|reconstructing -> ready       (user cancelled: not an error)
 *   capturing|reconstructing -> failed      (typed CaptureError)
 *   reconstructing -> done                  (OBJ + USDZ on disk)
 *   done -> uploading -> uploaded           (upload deps present: save the scan)
 *   uploading -> upload_failed              (upload rejected; retryUpload() retries)
 *
 * The upload leg is opt-in via CaptureFlowDeps.uploadScan: when it is absent
 * (the default in unit tests, and any non-configured build) the machine stops at
 * 'done' exactly as before, so existing behavior is preserved. When present (the
 * real deps built by defaultCaptureFlowDeps) a successful reconstruction flows
 * on through the upload path.
 *
 * The machine lives in {@link CaptureFlowController}, a plain class with every
 * module call injected through {@link CaptureFlowDeps}, so all transitions are
 * unit-testable in node without a device (see useCaptureFlow.test.ts and the
 * vitest.config.ts note about pure-TS logic tests). The React hook
 * {@link useCaptureFlow} is a thin lifecycle wrapper: it builds the controller
 * with the real module, mirrors its state into React state, and disposes it on
 * unmount (removing event listeners and cancelling any in-flight native work).
 */

import type { EventSubscription } from 'expo-modules-core';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  addCaptureStateListener,
  addReconstructionProgressListener,
  cancel as cancelCapture,
  CaptureError,
  mapNativeError,
  reconstruct,
  startCapture,
} from '../../modules/zells-capture';
import type {
  CaptureErrorCode,
  CaptureResult,
  CaptureState,
  CaptureStateEvent,
  ReconstructionProgressEvent,
  ReconstructOptions,
  ReconstructResult,
} from '../../modules/zells-capture';
import { getCaptureAvailability } from '../lib/nativeCapture';
import type { CaptureAvailability, CaptureUnavailableReason } from '../lib/nativeCapture';
import { asUploadError, newScanId, uploadScan } from '../lib/upload';
import type { Leg, UploadError, UploadScanParams, UploadScanResult } from '../lib/upload';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type CaptureFlowPhase =
  | 'checking'
  | 'unsupported'
  | 'ready'
  | 'capturing'
  | 'reconstructing'
  | 'done'
  | 'uploading'
  | 'uploaded'
  | 'upload_failed'
  | 'failed';

/** Device/OS context stamped onto the scan's capture_meta. Gathered by the
 * screen (which already imports react-native) and injected, so this module and
 * its node tests never statically import react-native. */
export interface CaptureMetaEnv {
  platform: string;
  osVersion: string;
  deviceModel: string | null;
}

export interface CaptureFlowState {
  phase: CaptureFlowPhase;
  /** Why capture is unavailable; set only in the 'unsupported' phase. */
  unavailableReason: CaptureUnavailableReason | null;
  /** Latest native guided-capture state; set during the 'capturing' phase. */
  captureState: CaptureState | null;
  /** Reconstruction completion, 0..1; meaningful in 'reconstructing'. */
  progress: number;
  /** Coarse native stage label (e.g. 'processing'), when reported. */
  progressStage: string | null;
  /** Result of the guided capture, once startCapture resolves. */
  capture: CaptureResult | null;
  /** Result of the reconstruction; set from the 'done' phase onward. */
  result: ReconstructResult | null;
  /** Typed capture error; set only in the 'failed' phase. */
  error: CaptureError | null;
  /** Typed upload error; set only in the 'upload_failed' phase. */
  uploadError: UploadError | null;
  /** Id of the saved scan; set in the 'uploaded' phase (used to route to it). */
  scanId: string | null;
}

export const INITIAL_CAPTURE_FLOW_STATE: CaptureFlowState = {
  phase: 'checking',
  unavailableReason: null,
  captureState: null,
  progress: 0,
  progressStage: null,
  capture: null,
  result: null,
  error: null,
  uploadError: null,
  scanId: null,
};

/** Phases from which start() may (re)enter the capture pipeline (i.e. rescan). */
const STARTABLE_PHASES: readonly CaptureFlowPhase[] = [
  'ready',
  'failed',
  'done',
  'uploaded',
  'upload_failed',
];

// ---------------------------------------------------------------------------
// Error copy
// ---------------------------------------------------------------------------

/**
 * Plain-language message per typed error code, written for the person holding
 * the phone (often a parent scanning a kid's leg), not for a developer.
 */
export const CAPTURE_ERROR_MESSAGES: Record<CaptureErrorCode, string> = {
  ERR_CAPTURE_UNAVAILABLE:
    'Capture is not available in this build. Use the Zells dev build on a LiDAR iPhone.',
  ERR_CAPTURE_UNSUPPORTED_DEVICE:
    'This iPhone cannot run guided capture. It needs a LiDAR sensor and iOS 17 or later.',
  ERR_CAPTURE_CANCELLED: 'The capture was cancelled before it finished.',
  ERR_CAPTURE_NO_IMAGES:
    'The capture did not collect enough usable photos. Find better light and move slowly around the leg.',
  ERR_RECONSTRUCTION_FAILED:
    'The photos could not be turned into a 3D model. Scan again with slow, overlapping passes around the leg.',
  ERR_EXPORT_FAILED: 'The model was built but could not be saved to a file. Run the scan again.',
  ERR_CAPTURE_UNKNOWN: 'Something went wrong during the scan. Run it again.',
};

/** Map a typed capture error to its user-facing message. */
export function captureErrorMessage(error: CaptureError): string {
  return CAPTURE_ERROR_MESSAGES[error.code];
}

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/**
 * Everything the state machine touches outside itself. The screen uses
 * {@link defaultCaptureFlowDeps} (the real module); tests inject fakes.
 */
export interface CaptureFlowDeps {
  getAvailability(): Promise<CaptureAvailability>;
  startCapture(): Promise<CaptureResult>;
  reconstruct(options?: ReconstructOptions): Promise<ReconstructResult>;
  cancel(): Promise<void>;
  addCaptureStateListener(listener: (event: CaptureStateEvent) => void): EventSubscription;
  addReconstructionProgressListener(
    listener: (event: ReconstructionProgressEvent) => void,
  ): EventSubscription;
  /**
   * Upload a completed scan (mesh -> storage, scan row, measure job). Optional:
   * when omitted the machine stops at 'done' and never enters the upload leg.
   * Injected so tests can drive upload states without a backend.
   */
  uploadScan?: (params: UploadScanParams) => Promise<UploadScanResult>;
  /** Gather device/OS context for capture_meta. Optional; injected by the
   * screen so this module never imports react-native. */
  captureEnv?: () => CaptureMetaEnv;
}

/** The real module wired into the deps shape. captureEnv is supplied by the
 * screen (capture.tsx), which already imports react-native. */
export function defaultCaptureFlowDeps(captureEnv?: () => CaptureMetaEnv): CaptureFlowDeps {
  return {
    getAvailability: getCaptureAvailability,
    startCapture,
    reconstruct,
    cancel: cancelCapture,
    addCaptureStateListener,
    addReconstructionProgressListener,
    uploadScan,
    captureEnv,
  };
}

// ---------------------------------------------------------------------------
// Controller (pure logic, no React)
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export interface CaptureFlowOptions {
  /** Which leg the scan is of. Defaults to 'L' until a leg picker exists. */
  leg?: Leg;
}

export class CaptureFlowController {
  private state: CaptureFlowState = INITIAL_CAPTURE_FLOW_STATE;
  private disposed = false;
  private listenersAttached = false;
  private subscriptions: EventSubscription[] = [];
  private readonly leg: Leg;
  /** Wall-clock start of the current capture, for capture_meta duration. */
  private captureStartedAt: number | null = null;
  /** Reconstruction result of the current attempt, so retryUpload can reuse it. */
  private lastResult: ReconstructResult | null = null;
  /** Scan id reused across upload retries so a partial failure is idempotent. */
  private uploadScanId: string | null = null;

  constructor(
    private readonly deps: CaptureFlowDeps,
    private readonly onChange: (state: CaptureFlowState) => void,
    options: CaptureFlowOptions = {},
  ) {
    this.leg = options.leg ?? 'L';
  }

  getState(): CaptureFlowState {
    return this.state;
  }

  /** Run the availability gate: checking -> ready | unsupported. */
  async initialize(): Promise<void> {
    this.patch(INITIAL_CAPTURE_FLOW_STATE);
    let availability: CaptureAvailability;
    try {
      availability = await this.deps.getAvailability();
    } catch {
      // getCaptureAvailability's contract is "never throws"; if an injected
      // implementation does anyway, treat it as an incapable device.
      availability = { supported: false, reason: 'device' };
    }
    if (this.disposed) {
      return;
    }
    if (!availability.supported) {
      this.patch({ phase: 'unsupported', unavailableReason: availability.reason });
      return;
    }
    this.patch({ phase: 'ready' });
  }

  /**
   * Run the pipeline: capturing -> reconstructing -> done. Also the retry
   * entry point from 'failed' and the scan-again entry point from 'done'.
   * No-op in every other phase (including while already running).
   */
  async start(): Promise<void> {
    if (this.disposed || !STARTABLE_PHASES.includes(this.state.phase)) {
      return;
    }
    this.attachListeners();
    this.captureStartedAt = Date.now();
    // A rescan starts a fresh scan: drop the previous attempt's upload identity
    // so we never overwrite an already-saved scan with a new capture.
    this.uploadScanId = null;
    this.lastResult = null;
    this.patch({
      phase: 'capturing',
      captureState: 'initializing',
      progress: 0,
      progressStage: null,
      capture: null,
      result: null,
      error: null,
      uploadError: null,
      scanId: null,
    });

    let capture: CaptureResult;
    try {
      capture = await this.deps.startCapture();
    } catch (error) {
      this.settleFailure(error);
      return;
    }
    if (this.disposed) {
      return;
    }

    this.patch({ phase: 'reconstructing', capture, progress: 0, progressStage: null });
    let result: ReconstructResult;
    try {
      // sessionDir deliberately omitted: the native side defaults to the
      // session startCapture just created (see ReconstructOptions).
      result = await this.deps.reconstruct({});
    } catch (error) {
      this.settleFailure(error);
      return;
    }
    if (this.disposed) {
      return;
    }
    this.lastResult = result;
    this.patch({ phase: 'done', result, progress: 1 });

    // Upload leg is opt-in (deps.uploadScan). When absent, the machine stops at
    // 'done' (prior behavior). When present, save the scan.
    if (this.deps.uploadScan && !this.disposed) {
      await this.runUpload(result);
    }
  }

  /**
   * Retry only the upload after an upload failure, reusing the same scan id so
   * the storage object, scan row, and job are not duplicated. A full rescan is
   * still available via start().
   */
  async retryUpload(): Promise<void> {
    if (this.disposed || this.state.phase !== 'upload_failed' || !this.lastResult) {
      return;
    }
    await this.runUpload(this.lastResult);
  }

  /** Upload the reconstructed mesh: done -> uploading -> uploaded | upload_failed. */
  private async runUpload(result: ReconstructResult): Promise<void> {
    if (this.disposed || !this.deps.uploadScan) {
      return;
    }
    // Allocate the scan id once and reuse it across retries: a retry then
    // overwrites the same object, upserts the same row, and returns the same
    // active job instead of orphaning a partially-uploaded scan.
    if (!this.uploadScanId) {
      this.uploadScanId = newScanId();
    }
    this.patch({ phase: 'uploading', uploadError: null });
    let uploaded: UploadScanResult;
    try {
      uploaded = await this.deps.uploadScan({
        localFileUri: result.objPath,
        leg: this.leg,
        captureMeta: this.buildCaptureMeta(result),
        scanId: this.uploadScanId,
      });
    } catch (error) {
      if (this.disposed) {
        return;
      }
      this.patch({ phase: 'upload_failed', uploadError: asUploadError(error) });
      return;
    }
    if (this.disposed) {
      return;
    }
    this.uploadScanId = uploaded.scanId;
    this.patch({ phase: 'uploaded', scanId: uploaded.scanId, uploadError: null });
  }

  /** Assemble capture_meta from what the flow knows plus injected device env.
   * Never geometry: just session/device/timing context (CLAUDE.md gotcha 5). */
  private buildCaptureMeta(result: ReconstructResult): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      sessionId: result.sessionId,
      imageCount: result.imageCount,
      detail: result.detail,
    };
    if (this.captureStartedAt != null) {
      meta.captureDurationMs = Date.now() - this.captureStartedAt;
    }
    if (this.deps.captureEnv) {
      const env = this.deps.captureEnv();
      meta.platform = env.platform;
      meta.osVersion = env.osVersion;
      if (env.deviceModel) {
        meta.deviceModel = env.deviceModel;
      }
    }
    return meta;
  }

  /**
   * Tear down on unmount: remove event listeners and, if native work is in
   * flight, cancel it. After dispose the controller ignores everything.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    const phaseAtDispose = this.state.phase;
    this.disposed = true;
    for (const subscription of this.subscriptions) {
      subscription.remove();
    }
    this.subscriptions = [];
    if (phaseAtDispose === 'capturing' || phaseAtDispose === 'reconstructing') {
      this.deps.cancel().catch(() => {
        // Best effort: the screen is gone; there is nothing left to notify.
      });
    }
  }

  private attachListeners(): void {
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    this.subscriptions.push(
      this.deps.addCaptureStateListener((event) => {
        if (this.state.phase === 'capturing') {
          this.patch({ captureState: event.state });
        }
      }),
      this.deps.addReconstructionProgressListener((event) => {
        if (this.state.phase === 'reconstructing') {
          this.patch({ progress: clamp01(event.fraction), progressStage: event.stage ?? null });
        }
      }),
    );
  }

  private settleFailure(error: unknown): void {
    if (this.disposed) {
      return;
    }
    const mapped = mapNativeError(error);
    if (mapped.code === 'ERR_CAPTURE_CANCELLED') {
      // Backing out of the native UI is a normal path, not a failure.
      this.patch({ phase: 'ready', captureState: null, progress: 0, progressStage: null });
      return;
    }
    this.patch({ phase: 'failed', error: mapped });
  }

  private patch(partial: Partial<CaptureFlowState>): void {
    if (this.disposed) {
      return;
    }
    this.state = { ...this.state, ...partial };
    this.onChange(this.state);
  }
}

// ---------------------------------------------------------------------------
// Hook (thin React wrapper)
// ---------------------------------------------------------------------------

export interface UseCaptureFlowResult {
  state: CaptureFlowState;
  /** Start the capture pipeline (or rescan from a terminal phase). */
  start: () => void;
  /** Retry only the upload after an upload failure (no rescan). */
  retryUpload: () => void;
}

export interface UseCaptureFlowOptions {
  /** Which leg the scan is of. Defaults to 'L'. */
  leg?: Leg;
  /** Device/OS context for capture_meta (screen-provided; keeps react-native
   * out of this module's import graph). */
  captureEnv?: () => CaptureMetaEnv;
  /** Override deps (tests / non-default wiring). When set, captureEnv is ignored
   * (pass it inside deps instead). */
  deps?: CaptureFlowDeps;
}

/**
 * Drive the capture flow for a screen. Checks availability on mount, exposes
 * start() and retryUpload(), and cleans up (listeners + native cancel) on
 * unmount.
 */
export function useCaptureFlow(options: UseCaptureFlowOptions = {}): UseCaptureFlowResult {
  const [state, setState] = useState<CaptureFlowState>(INITIAL_CAPTURE_FLOW_STATE);
  const controllerRef = useRef<CaptureFlowController | null>(null);
  // Options are captured once on mount, matching the controller's lifetime.
  const optionsRef = useRef(options);

  useEffect(() => {
    const { deps, captureEnv, leg } = optionsRef.current;
    const controller = new CaptureFlowController(
      deps ?? defaultCaptureFlowDeps(captureEnv),
      setState,
      { leg },
    );
    controllerRef.current = controller;
    void controller.initialize();
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    void controllerRef.current?.start();
  }, []);

  const retryUpload = useCallback(() => {
    void controllerRef.current?.retryUpload();
  }, []);

  return { state, start, retryUpload };
}
