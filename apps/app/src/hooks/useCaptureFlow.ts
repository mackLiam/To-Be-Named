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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type CaptureFlowPhase =
  'checking' | 'unsupported' | 'ready' | 'capturing' | 'reconstructing' | 'done' | 'failed';

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
  /** Result of the reconstruction; set in the 'done' phase. */
  result: ReconstructResult | null;
  /** Typed error; set only in the 'failed' phase. */
  error: CaptureError | null;
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
};

/** Phases from which start() may (re)enter the capture pipeline. */
const STARTABLE_PHASES: readonly CaptureFlowPhase[] = ['ready', 'failed', 'done'];

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
}

/** The real module wired into the deps shape. */
export function defaultCaptureFlowDeps(): CaptureFlowDeps {
  return {
    getAvailability: getCaptureAvailability,
    startCapture,
    reconstruct,
    cancel: cancelCapture,
    addCaptureStateListener,
    addReconstructionProgressListener,
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

export class CaptureFlowController {
  private state: CaptureFlowState = INITIAL_CAPTURE_FLOW_STATE;
  private disposed = false;
  private listenersAttached = false;
  private subscriptions: EventSubscription[] = [];

  constructor(
    private readonly deps: CaptureFlowDeps,
    private readonly onChange: (state: CaptureFlowState) => void,
  ) {}

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
    this.patch({
      phase: 'capturing',
      captureState: 'initializing',
      progress: 0,
      progressStage: null,
      capture: null,
      result: null,
      error: null,
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
    this.patch({ phase: 'done', result, progress: 1 });
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
  /** Start the capture pipeline (or retry / scan again). */
  start: () => void;
}

/**
 * Drive the capture flow for a screen. Checks availability on mount, exposes
 * start(), and cleans up (listeners + native cancel) on unmount.
 */
export function useCaptureFlow(deps?: CaptureFlowDeps): UseCaptureFlowResult {
  const [state, setState] = useState<CaptureFlowState>(INITIAL_CAPTURE_FLOW_STATE);
  const controllerRef = useRef<CaptureFlowController | null>(null);
  // Deps are captured once on mount, matching the controller's lifetime.
  const depsRef = useRef(deps);

  useEffect(() => {
    const controller = new CaptureFlowController(
      depsRef.current ?? defaultCaptureFlowDeps(),
      setState,
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

  return { state, start };
}
