import { describe, expect, it, vi } from 'vitest';

// The hook file imports the module's public index (which reaches for
// expo-modules-core) and src/lib/nativeCapture (which imports react-native).
// Neither loads in node, so mock both; the controller under test never touches
// them because every call goes through injected CaptureFlowDeps. The error
// classes are re-exported from the module's pure errors.ts, so importActual
// keeps the real CaptureError / mapNativeError the controller relies on.
vi.mock('../../modules/forms-capture', async () => {
  const errors = await vi.importActual('../../modules/forms-capture/src/errors');
  return {
    ...errors,
    isSupported: vi.fn(async () => false),
    startCapture: vi.fn(),
    reconstruct: vi.fn(),
    cancel: vi.fn(),
    addCaptureStateListener: vi.fn(),
    addReconstructionProgressListener: vi.fn(),
  };
});
vi.mock('../lib/nativeCapture', () => ({
  getCaptureAvailability: vi.fn(),
}));

import { CaptureError } from '../../modules/forms-capture';
import type {
  CaptureResult,
  PhotoCaptureResult,
  ReconstructResult,
} from '../../modules/forms-capture';
import { UploadError } from '../lib/upload';
import type {
  UploadPhotoBundleParams,
  UploadPhotoBundleResult,
  UploadScanParams,
  UploadScanResult,
} from '../lib/upload';
import {
  CAPTURE_ERROR_MESSAGES,
  CaptureFlowController,
  captureErrorMessage,
  type CaptureFlowDeps,
  type CaptureFlowState,
} from './useCaptureFlow';

const UPLOAD_RESULT: UploadScanResult = {
  scanId: 'scan-1',
  meshPath: 'user-1/scan-1.obj',
  jobId: 'job-1',
  fake: false,
};

/** A typed uploadScan mock so calls[].scanId etc. are inspectable. */
function uploadMock() {
  return vi.fn((_params: UploadScanParams) => Promise.resolve(UPLOAD_RESULT));
}

const PHOTO_RESULT: PhotoCaptureResult = {
  sessionId: 'photo-session-1',
  bundleDir: '/sandbox/photo-captures/photo-session-1',
  manifestPath: '/sandbox/photo-captures/photo-session-1/capture.json',
  imageCount: 48,
  coverage: 0.83,
};

const PHOTO_UPLOAD_RESULT: UploadPhotoBundleResult = {
  scanId: 'scan-p',
  bundlePath: 'user-1/scan-p',
  imageCount: 48,
  jobId: 'job-p',
  fake: false,
};

function photoUploadMock() {
  return vi.fn((_params: UploadPhotoBundleParams) => Promise.resolve(PHOTO_UPLOAD_RESULT));
}

const CAPTURE_RESULT: CaptureResult = {
  sessionId: 'session-1',
  imageDir: '/sandbox/captures/session-1/images',
  imageCount: 42,
};

const RECONSTRUCT_RESULT: ReconstructResult = {
  sessionId: 'session-1',
  usdzPath: '/sandbox/captures/session-1/model.usdz',
  objPath: '/sandbox/captures/session-1/model.obj',
  detail: 'reduced',
  imageCount: 42,
};

/** A promise with its resolve/reject exposed, to settle native calls mid-test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let pending microtasks (awaits inside the controller) run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeDeps(overrides: Partial<CaptureFlowDeps> = {}) {
  const stateSub = { remove: vi.fn() };
  const progressSub = { remove: vi.fn() };
  let stateListener: ((event: { state: string; message?: string }) => void) | undefined;
  let progressListener: ((event: { fraction: number; stage?: string }) => void) | undefined;

  const deps: CaptureFlowDeps = {
    getAvailability: vi.fn(async () => ({
      supported: true,
      reason: 'ok' as const,
      mode: 'object' as const,
    })),
    startPhotoCapture: vi.fn(async () => PHOTO_RESULT),
    startCapture: vi.fn(async () => CAPTURE_RESULT),
    reconstruct: vi.fn(async () => RECONSTRUCT_RESULT),
    cancel: vi.fn(async () => {}),
    addCaptureStateListener: vi.fn((listener) => {
      stateListener = listener;
      return stateSub;
    }),
    addReconstructionProgressListener: vi.fn((listener) => {
      progressListener = listener;
      return progressSub;
    }),
    ...overrides,
  };

  return {
    deps,
    stateSub,
    progressSub,
    emitState: (state: string) => stateListener?.({ state }),
    emitProgress: (fraction: number, stage?: string) => progressListener?.({ fraction, stage }),
  };
}

function makeController(deps: CaptureFlowDeps) {
  const states: CaptureFlowState[] = [];
  const controller = new CaptureFlowController(deps, (state) => states.push(state));
  const phases = () => states.map((state) => state.phase);
  return { controller, states, phases };
}

describe('initialize (availability gate)', () => {
  it('goes checking -> ready on a supported device', async () => {
    const { deps } = makeDeps();
    const { controller, phases } = makeController(deps);
    await controller.initialize();
    expect(phases()).toEqual(['checking', 'ready']);
  });

  it('short-circuits to unsupported with the reason, and start() is then a no-op', async () => {
    const { deps } = makeDeps({
      getAvailability: vi.fn(async () => ({
        supported: false,
        reason: 'platform' as const,
        mode: null,
      })),
    });
    const { controller } = makeController(deps);
    await controller.initialize();
    expect(controller.getState().phase).toBe('unsupported');
    expect(controller.getState().unavailableReason).toBe('platform');

    await controller.start();
    expect(deps.startCapture).not.toHaveBeenCalled();
    expect(deps.addCaptureStateListener).not.toHaveBeenCalled();
    expect(controller.getState().phase).toBe('unsupported');
  });

  it('treats an availability check that throws as an incapable device', async () => {
    const { deps } = makeDeps({
      getAvailability: vi.fn(async () => {
        throw new Error('bridge exploded');
      }),
    });
    const { controller } = makeController(deps);
    await controller.initialize();
    expect(controller.getState()).toMatchObject({
      phase: 'unsupported',
      unavailableReason: 'device',
    });
  });
});

describe('happy path', () => {
  it('runs ready -> capturing -> reconstructing -> done with events applied', async () => {
    const captureCall = deferred<CaptureResult>();
    const reconstructCall = deferred<ReconstructResult>();
    const { deps, emitState, emitProgress } = makeDeps({
      startCapture: vi.fn(() => captureCall.promise),
      reconstruct: vi.fn(() => reconstructCall.promise),
    });
    const { controller, phases } = makeController(deps);
    await controller.initialize();

    const started = controller.start();
    expect(controller.getState().phase).toBe('capturing');
    expect(controller.getState().captureState).toBe('initializing');

    emitState('capturing');
    expect(controller.getState().captureState).toBe('capturing');

    captureCall.resolve(CAPTURE_RESULT);
    await flush();
    expect(controller.getState().phase).toBe('reconstructing');
    expect(controller.getState().capture).toEqual(CAPTURE_RESULT);
    expect(deps.reconstruct).toHaveBeenCalledTimes(1);

    emitProgress(0.4, 'processing');
    expect(controller.getState().progress).toBe(0.4);
    expect(controller.getState().progressStage).toBe('processing');

    reconstructCall.resolve(RECONSTRUCT_RESULT);
    await started;
    expect(controller.getState().phase).toBe('done');
    expect(controller.getState().result).toEqual(RECONSTRUCT_RESULT);
    expect(controller.getState().progress).toBe(1);
    expect(phases()).toEqual([
      'checking',
      'ready',
      'capturing',
      'capturing',
      'reconstructing',
      'reconstructing',
      'done',
    ]);
  });

  it('clamps out-of-range progress fractions', async () => {
    const reconstructCall = deferred<ReconstructResult>();
    const { deps, emitProgress } = makeDeps({
      reconstruct: vi.fn(() => reconstructCall.promise),
    });
    const { controller } = makeController(deps);
    await controller.initialize();
    const started = controller.start();
    await flush();
    expect(controller.getState().phase).toBe('reconstructing');

    emitProgress(1.7);
    expect(controller.getState().progress).toBe(1);
    emitProgress(-0.2);
    expect(controller.getState().progress).toBe(0);
    emitProgress(Number.NaN);
    expect(controller.getState().progress).toBe(0);

    reconstructCall.resolve(RECONSTRUCT_RESULT);
    await started;
  });

  it('ignores events that arrive outside their phase', async () => {
    const captureCall = deferred<CaptureResult>();
    const { deps, emitState, emitProgress } = makeDeps({
      startCapture: vi.fn(() => captureCall.promise),
    });
    const { controller } = makeController(deps);
    await controller.initialize();

    // Before start: both ignored.
    emitState('capturing');
    emitProgress(0.5);
    expect(controller.getState()).toMatchObject({ captureState: null, progress: 0 });

    const started = controller.start();
    // Progress while still capturing: ignored.
    emitProgress(0.5);
    expect(controller.getState().progress).toBe(0);

    captureCall.resolve(CAPTURE_RESULT);
    await started;
    // Capture-state event after capture finished: ignored.
    emitState('finishing');
    expect(controller.getState().captureState).toBe('initializing');
  });

  it('start() is a no-op while already running (double tap guard)', async () => {
    const captureCall = deferred<CaptureResult>();
    const { deps } = makeDeps({ startCapture: vi.fn(() => captureCall.promise) });
    const { controller } = makeController(deps);
    await controller.initialize();

    const first = controller.start();
    await controller.start();
    expect(deps.startCapture).toHaveBeenCalledTimes(1);

    captureCall.resolve(CAPTURE_RESULT);
    await first;
  });
});

describe('failures', () => {
  it('maps a raw native error mid-capture to a typed failed state', async () => {
    const { deps } = makeDeps({
      startCapture: vi
        .fn()
        .mockRejectedValue({ code: 'ERR_CAPTURE_NO_IMAGES', message: 'only 3 images' }),
    });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.start();

    const state = controller.getState();
    expect(state.phase).toBe('failed');
    expect(state.error).toBeInstanceOf(CaptureError);
    expect(state.error?.code).toBe('ERR_CAPTURE_NO_IMAGES');
    expect(deps.reconstruct).not.toHaveBeenCalled();
  });

  it('retries from failed: start() runs the pipeline again and can reach done', async () => {
    const { deps } = makeDeps({
      startCapture: vi
        .fn()
        .mockRejectedValueOnce(new CaptureError('ERR_CAPTURE_UNKNOWN', 'flake'))
        .mockResolvedValueOnce(CAPTURE_RESULT),
    });
    const { controller } = makeController(deps);
    await controller.initialize();

    await controller.start();
    expect(controller.getState().phase).toBe('failed');

    await controller.start();
    expect(controller.getState().phase).toBe('done');
    expect(controller.getState().error).toBeNull();
    // Listeners were attached once, not once per attempt.
    expect(deps.addCaptureStateListener).toHaveBeenCalledTimes(1);
    expect(deps.addReconstructionProgressListener).toHaveBeenCalledTimes(1);
  });

  it('moves to failed when reconstruction fails', async () => {
    const { deps } = makeDeps({
      reconstruct: vi
        .fn()
        .mockRejectedValue(new CaptureError('ERR_RECONSTRUCTION_FAILED', 'no model')),
    });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.start();

    const state = controller.getState();
    expect(state.phase).toBe('failed');
    expect(state.error?.code).toBe('ERR_RECONSTRUCTION_FAILED');
    // The capture result is kept for debugging even though reconstruction failed.
    expect(state.capture).toEqual(CAPTURE_RESULT);
  });
});

describe('cancellation', () => {
  it('returns to ready (not failed) when the user backs out of the native capture UI', async () => {
    const { deps } = makeDeps({
      startCapture: vi
        .fn()
        .mockRejectedValue(new CaptureError('ERR_CAPTURE_CANCELLED', 'user cancelled')),
    });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.start();

    expect(controller.getState().phase).toBe('ready');
    expect(controller.getState().error).toBeNull();
  });

  it('returns to ready when reconstruction is cancelled', async () => {
    const { deps } = makeDeps({
      reconstruct: vi
        .fn()
        .mockRejectedValue(new CaptureError('ERR_CAPTURE_CANCELLED', 'cancelled')),
    });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.start();

    expect(controller.getState().phase).toBe('ready');
    expect(controller.getState().error).toBeNull();
  });
});

describe('dispose (unmount)', () => {
  it('during checking: ignores the late availability result', async () => {
    const availabilityCall = deferred<{ supported: boolean; reason: 'ok'; mode: 'object' }>();
    const { deps } = makeDeps({
      getAvailability: vi.fn(() => availabilityCall.promise),
    });
    const { controller } = makeController(deps);
    const initialized = controller.initialize();

    controller.dispose();
    availabilityCall.resolve({ supported: true, reason: 'ok', mode: 'object' });
    await initialized;

    expect(controller.getState().phase).toBe('checking');
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it('during ready: does not call cancel and has no listeners to remove', async () => {
    const { deps, stateSub, progressSub } = makeDeps();
    const { controller } = makeController(deps);
    await controller.initialize();

    controller.dispose();
    expect(deps.cancel).not.toHaveBeenCalled();
    expect(stateSub.remove).not.toHaveBeenCalled();
    expect(progressSub.remove).not.toHaveBeenCalled();
  });

  it('during capturing: cancels native work, removes listeners, and ignores the late result', async () => {
    const captureCall = deferred<CaptureResult>();
    const { deps, stateSub, progressSub, emitState } = makeDeps({
      startCapture: vi.fn(() => captureCall.promise),
    });
    const { controller, states } = makeController(deps);
    await controller.initialize();
    const started = controller.start();

    controller.dispose();
    expect(deps.cancel).toHaveBeenCalledTimes(1);
    expect(stateSub.remove).toHaveBeenCalledTimes(1);
    expect(progressSub.remove).toHaveBeenCalledTimes(1);

    const updates = states.length;
    // A straggling event (real removal happens in the native emitter) and the
    // late capture result must both be ignored after dispose.
    emitState('finishing');
    captureCall.resolve(CAPTURE_RESULT);
    await started;
    expect(states.length).toBe(updates);
    expect(controller.getState().phase).toBe('capturing');
    expect(deps.reconstruct).not.toHaveBeenCalled();
  });

  it('during reconstructing: cancels native work and never reaches done', async () => {
    const reconstructCall = deferred<ReconstructResult>();
    const { deps, emitProgress } = makeDeps({
      reconstruct: vi.fn(() => reconstructCall.promise),
    });
    const { controller } = makeController(deps);
    await controller.initialize();
    const started = controller.start();
    await flush();
    expect(controller.getState().phase).toBe('reconstructing');

    controller.dispose();
    expect(deps.cancel).toHaveBeenCalledTimes(1);

    emitProgress(0.9);
    reconstructCall.resolve(RECONSTRUCT_RESULT);
    await started;
    expect(controller.getState().phase).toBe('reconstructing');
    expect(controller.getState().progress).toBe(0);
  });

  it('survives a cancel() that rejects', async () => {
    const captureCall = deferred<CaptureResult>();
    const { deps } = makeDeps({
      startCapture: vi.fn(() => captureCall.promise),
      cancel: vi.fn(async () => {
        throw new Error('nothing to cancel');
      }),
    });
    const { controller } = makeController(deps);
    await controller.initialize();
    void controller.start();

    expect(() => controller.dispose()).not.toThrow();
    await flush();
    captureCall.reject(new CaptureError('ERR_CAPTURE_CANCELLED', 'cancelled'));
    await flush();
  });

  it('is idempotent', async () => {
    const captureCall = deferred<CaptureResult>();
    const { deps, stateSub } = makeDeps({ startCapture: vi.fn(() => captureCall.promise) });
    const { controller } = makeController(deps);
    await controller.initialize();
    void controller.start();

    controller.dispose();
    controller.dispose();
    expect(deps.cancel).toHaveBeenCalledTimes(1);
    expect(stateSub.remove).toHaveBeenCalledTimes(1);
    captureCall.reject(new CaptureError('ERR_CAPTURE_CANCELLED', 'cancelled'));
    await flush();
  });
});

describe('upload leg', () => {
  it('with no uploadScan dep, stops at done (upload leg is opt-in, prior behavior)', async () => {
    const { deps } = makeDeps();
    const { controller, phases } = makeController(deps);
    await controller.initialize();
    await controller.start();
    expect(controller.getState().phase).toBe('done');
    expect(phases()).toEqual(['checking', 'ready', 'capturing', 'reconstructing', 'done']);
  });

  it('done -> uploading -> uploaded, calling uploadScan with the obj path and default leg L', async () => {
    const uploadScan = uploadMock();
    const { deps } = makeDeps({ uploadScan });
    const { controller, phases } = makeController(deps);
    await controller.initialize();
    await controller.start();

    expect(controller.getState().phase).toBe('uploaded');
    expect(controller.getState().scanId).toBe('scan-1');
    expect(uploadScan).toHaveBeenCalledTimes(1);
    const arg = uploadScan.mock.calls[0]?.[0];
    expect(arg?.localFileUri).toBe(RECONSTRUCT_RESULT.objPath);
    expect(arg?.leg).toBe('L');
    expect(arg?.scanId).toBeTruthy();
    expect(arg?.captureMeta).toMatchObject({
      sessionId: 'session-1',
      imageCount: 42,
      detail: 'reduced',
    });
    expect(phases()).toContain('uploading');
    expect(phases()).toContain('uploaded');
  });

  it('passes the configured leg to uploadScan', async () => {
    const uploadScan = uploadMock();
    const { deps } = makeDeps({ uploadScan });
    const controller = new CaptureFlowController(deps, () => {}, { leg: 'R' });
    await controller.initialize();
    await controller.start();
    const arg = uploadScan.mock.calls[0]?.[0];
    expect(arg?.leg).toBe('R');
  });

  it('merges injected captureEnv (and a duration) into capture_meta', async () => {
    const uploadScan = uploadMock();
    const captureEnv = () => ({ platform: 'ios', osVersion: '17.5', deviceModel: 'iPhone15,2' });
    const { deps } = makeDeps({ uploadScan, captureEnv });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.start();
    const meta = uploadScan.mock.calls[0]?.[0]?.captureMeta;
    expect(meta).toMatchObject({
      platform: 'ios',
      osVersion: '17.5',
      deviceModel: 'iPhone15,2',
      sessionId: 'session-1',
    });
    expect(meta).toHaveProperty('captureDurationMs');
  });

  it('upload failure -> upload_failed; retryUpload reuses the scan id and reaches uploaded', async () => {
    const uploadScan = uploadMock()
      .mockRejectedValueOnce(new UploadError('ERR_UPLOAD_STORAGE', 'boom'))
      .mockResolvedValueOnce(UPLOAD_RESULT);
    const { deps } = makeDeps({ uploadScan });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.start();

    expect(controller.getState().phase).toBe('upload_failed');
    expect(controller.getState().uploadError).toBeInstanceOf(UploadError);
    expect(controller.getState().uploadError?.code).toBe('ERR_UPLOAD_STORAGE');
    const firstScanId = uploadScan.mock.calls[0]?.[0]?.scanId;

    await controller.retryUpload();
    expect(controller.getState().phase).toBe('uploaded');
    expect(controller.getState().uploadError).toBeNull();
    const secondScanId = uploadScan.mock.calls[1]?.[0]?.scanId;
    expect(secondScanId).toBe(firstScanId);
    expect(uploadScan).toHaveBeenCalledTimes(2);
  });

  it('retryUpload is a no-op when not in upload_failed', async () => {
    const uploadScan = uploadMock();
    const { deps } = makeDeps({ uploadScan });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.retryUpload();
    expect(uploadScan).not.toHaveBeenCalled();
  });

  it('rescan after a successful upload allocates a fresh scan id', async () => {
    const uploadScan = uploadMock();
    const { deps } = makeDeps({ uploadScan });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.start();
    const firstId = uploadScan.mock.calls[0]?.[0]?.scanId;
    await controller.start();
    const secondId = uploadScan.mock.calls[1]?.[0]?.scanId;
    expect(firstId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
  });
});

describe('photos mode (non-LiDAR)', () => {
  function photoDeps(overrides: Partial<CaptureFlowDeps> = {}) {
    return makeDeps({
      getAvailability: vi.fn(async () => ({
        supported: true,
        reason: 'ok' as const,
        mode: 'photos' as const,
      })),
      ...overrides,
    });
  }

  it('records the mode on ready', async () => {
    const { deps } = photoDeps();
    const { controller } = makeController(deps);
    await controller.initialize();
    expect(controller.getState()).toMatchObject({ phase: 'ready', mode: 'photos' });
  });

  it('runs capturing -> done with the bundle and never reconstructs on device', async () => {
    const { deps } = photoDeps();
    const { controller, phases } = makeController(deps);
    await controller.initialize();
    await controller.start();
    expect(phases()).toEqual(['checking', 'ready', 'capturing', 'done']);
    expect(deps.startPhotoCapture).toHaveBeenCalledOnce();
    expect(deps.startCapture).not.toHaveBeenCalled();
    expect(deps.reconstruct).not.toHaveBeenCalled();
    expect(controller.getState().photoCapture).toEqual(PHOTO_RESULT);
    expect(controller.getState().result).toBeNull();
  });

  it('object mode never calls startPhotoCapture', async () => {
    const { deps } = makeDeps({ uploadPhotoBundle: photoUploadMock() });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.start();
    expect(deps.startPhotoCapture).not.toHaveBeenCalled();
    expect(deps.uploadPhotoBundle).not.toHaveBeenCalled();
  });

  it('done -> uploading -> uploaded via uploadPhotoBundle with the bundle dir and meta', async () => {
    const uploadPhotoBundle = photoUploadMock();
    const uploadScan = uploadMock();
    const { deps } = photoDeps({ uploadPhotoBundle, uploadScan });
    const { controller, phases } = makeController(deps);
    await controller.initialize();
    await controller.start();
    expect(phases()).toEqual(['checking', 'ready', 'capturing', 'done', 'uploading', 'uploaded']);
    expect(uploadScan).not.toHaveBeenCalled();
    const params = uploadPhotoBundle.mock.calls[0]?.[0];
    expect(params).toMatchObject({
      bundleDir: PHOTO_RESULT.bundleDir,
      leg: 'L',
      captureMeta: {
        sessionId: 'photo-session-1',
        imageCount: 48,
        coverage: 0.83,
        captureKind: 'photos',
      },
    });
    expect(params?.scanId).toBeTruthy();
    expect(controller.getState().scanId).toBe('scan-p');
  });

  it('cancel during photo capture returns to ready, not failed', async () => {
    const { deps } = photoDeps({
      startPhotoCapture: vi.fn(async () => {
        throw { code: 'ERR_CAPTURE_CANCELLED', message: 'The capture session was cancelled.' };
      }),
    });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.start();
    expect(controller.getState()).toMatchObject({ phase: 'ready', error: null, mode: 'photos' });
  });

  it('camera denied lands in failed with the typed code', async () => {
    const { deps } = photoDeps({
      startPhotoCapture: vi.fn(async () => {
        throw { code: 'ERR_CAPTURE_CAMERA_DENIED', message: 'Camera access is denied.' };
      }),
    });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.start();
    expect(controller.getState().phase).toBe('failed');
    expect(controller.getState().error?.code).toBe('ERR_CAPTURE_CAMERA_DENIED');
  });

  it('upload failure then retryUpload reuses the scan id and the same bundle', async () => {
    const uploadPhotoBundle = vi
      .fn((_params: UploadPhotoBundleParams) => Promise.resolve(PHOTO_UPLOAD_RESULT))
      .mockRejectedValueOnce(new UploadError('ERR_UPLOAD_STORAGE', 'net'));
    const { deps } = photoDeps({ uploadPhotoBundle });
    const { controller } = makeController(deps);
    await controller.initialize();
    await controller.start();
    expect(controller.getState().phase).toBe('upload_failed');
    expect(controller.getState().uploadError?.code).toBe('ERR_UPLOAD_STORAGE');

    await controller.retryUpload();
    expect(controller.getState().phase).toBe('uploaded');
    expect(deps.startPhotoCapture).toHaveBeenCalledOnce();
    const [first, second] = uploadPhotoBundle.mock.calls.map((call) => call[0]);
    expect(second?.scanId).toBe(first?.scanId);
    expect(second?.bundleDir).toBe(PHOTO_RESULT.bundleDir);
  });

  it('dispose during photo capture cancels native work and ignores the late result', async () => {
    const call = deferred<PhotoCaptureResult>();
    const { deps } = photoDeps({ startPhotoCapture: vi.fn(() => call.promise) });
    const { controller } = makeController(deps);
    await controller.initialize();
    const started = controller.start();
    controller.dispose();
    call.resolve(PHOTO_RESULT);
    await started;
    expect(deps.cancel).toHaveBeenCalledOnce();
    expect(controller.getState().phase).toBe('capturing');
  });
});

describe('captureErrorMessage', () => {
  it('has a non-empty plain-language message for every error code', () => {
    for (const [code, message] of Object.entries(CAPTURE_ERROR_MESSAGES)) {
      expect(message.length, code).toBeGreaterThan(0);
    }
  });

  it('maps an error instance to its message by code', () => {
    const error = new CaptureError('ERR_RECONSTRUCTION_FAILED', 'raw native detail');
    expect(captureErrorMessage(error)).toBe(CAPTURE_ERROR_MESSAGES.ERR_RECONSTRUCTION_FAILED);
  });
});
