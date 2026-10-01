import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureError, CaptureUnavailableError } from './src/errors';
import type { FormsCaptureNativeModule } from './src/types';

// A mutable holder so each test can flip the native module between "absent"
// (null) and a fake implementation. Hoisted so the vi.mock factory below can
// close over it (vi.mock is hoisted above imports).
const mocks = vi.hoisted(() => ({
  native: null as FormsCaptureNativeModule | null,
}));

// Mock the single boundary file. The public wrapper (index.ts) is then a pure
// function of `FormsCaptureNative`, and no native runtime is needed.
vi.mock('./src/native', () => ({
  get FormsCaptureNative() {
    return mocks.native;
  },
}));

// Import after the mock is registered. Using dynamic import inside each test
// group keeps the live-binding getter honest.
import * as capture from './index';

afterEach(() => {
  mocks.native = null;
  vi.clearAllMocks();
});

describe('when the native module is absent (web / Android / Simulator / Expo Go)', () => {
  beforeEach(() => {
    mocks.native = null;
  });

  it('reports itself unavailable', () => {
    expect(capture.isNativeModuleAvailable()).toBe(false);
  });

  it('isSupported resolves false without throwing', async () => {
    await expect(capture.isSupported()).resolves.toBe(false);
  });

  it('startCapture rejects with CaptureUnavailableError', async () => {
    await expect(capture.startCapture()).rejects.toBeInstanceOf(CaptureUnavailableError);
    await expect(capture.startCapture()).rejects.toMatchObject({
      code: 'ERR_CAPTURE_UNAVAILABLE',
    });
  });

  it('reconstruct rejects with CaptureUnavailableError', async () => {
    await expect(capture.reconstruct()).rejects.toBeInstanceOf(CaptureUnavailableError);
  });

  it('cancel resolves quietly (nothing to cancel)', async () => {
    await expect(capture.cancel()).resolves.toBeUndefined();
  });

  it('event subscriptions return a safe no-op that can be removed', () => {
    const stateSub = capture.addCaptureStateListener(() => {});
    const progressSub = capture.addReconstructionProgressListener(() => {});
    const statsSub = capture.addPhotoCaptureStatsListener(() => {});
    expect(() => statsSub.remove()).not.toThrow();
    expect(() => stateSub.remove()).not.toThrow();
    expect(() => progressSub.remove()).not.toThrow();
  });
});

const PHOTO_RESULT = {
  sessionId: 'p1',
  bundleDir: '/b',
  manifestPath: '/b/capture.json',
  imageCount: 48,
  coverage: 0.8,
  mode: 'solo' as const,
  finishedEarly: false,
};

describe('photo capture when the native module is absent', () => {
  it('isPhotoCaptureSupported resolves false', async () => {
    await expect(capture.isPhotoCaptureSupported()).resolves.toBe(false);
  });

  it('startPhotoCapture rejects with CaptureUnavailableError', async () => {
    await expect(capture.startPhotoCapture()).rejects.toBeInstanceOf(CaptureUnavailableError);
  });

  it('startSilhouetteCapture rejects with CaptureUnavailableError', async () => {
    await expect(capture.startSilhouetteCapture({ leg: 'L' })).rejects.toBeInstanceOf(
      CaptureUnavailableError,
    );
  });

  it('addSilhouetteStatsListener returns a removable no-op', () => {
    expect(() => capture.addSilhouetteStatsListener(() => {}).remove()).not.toThrow();
  });
});

const SILHOUETTE_RESULT = {
  method: 'silhouette' as const,
  sessionId: 'sil-1',
  bundleDir: '/d/sil-1',
  manifestPath: '/d/sil-1/capture.json',
  imageCount: 5,
  coverage: 1,
  mode: 'solo' as const,
  finishedEarly: false,
  floorFound: true,
};

describe('when the native module is present', () => {
  const makeNative = (over: Partial<FormsCaptureNativeModule> = {}): FormsCaptureNativeModule => ({
    isSupported: vi.fn(async () => true),
    startCapture: vi.fn(async () => ({ sessionId: 's1', imageDir: '/d', imageCount: 42 })),
    reconstruct: vi.fn(async () => ({
      sessionId: 's1',
      usdzPath: '/d/model.usdz',
      objPath: '/d/model.obj',
      detail: 'reduced' as const,
      imageCount: 42,
    })),
    cancel: vi.fn(async () => {}),
    isPhotoCaptureSupported: vi.fn(async () => true),
    startPhotoCapture: vi.fn(async () => PHOTO_RESULT),
    startSilhouetteCapture: vi.fn(async () => SILHOUETTE_RESULT),
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    ...over,
  });

  it('isSupported returns the native boolean', async () => {
    mocks.native = makeNative({ isSupported: vi.fn(async () => true) });
    await expect(capture.isSupported()).resolves.toBe(true);

    mocks.native = makeNative({ isSupported: vi.fn(async () => false) });
    await expect(capture.isSupported()).resolves.toBe(false);
  });

  it('isSupported swallows a native throw into false', async () => {
    mocks.native = makeNative({
      isSupported: vi.fn(async () => {
        throw new Error('bridge exploded');
      }),
    });
    await expect(capture.isSupported()).resolves.toBe(false);
  });

  it('startCapture resolves the native result', async () => {
    mocks.native = makeNative();
    await expect(capture.startCapture()).resolves.toEqual({
      sessionId: 's1',
      imageDir: '/d',
      imageCount: 42,
    });
  });

  it('startCapture maps a native error to a typed CaptureError', async () => {
    mocks.native = makeNative({
      startCapture: vi.fn(async () => {
        throw { code: 'ERR_CAPTURE_CANCELLED', message: 'user backed out' };
      }),
    });
    const err = await capture.startCapture().catch((e) => e);
    expect(err).toBeInstanceOf(CaptureError);
    expect(err.code).toBe('ERR_CAPTURE_CANCELLED');
  });

  it('reconstruct forwards options and resolves the native result', async () => {
    const native = makeNative();
    mocks.native = native;
    const result = await capture.reconstruct({ detail: 'reduced' });
    expect(native.reconstruct).toHaveBeenCalledWith({ detail: 'reduced' });
    expect(result.objPath).toBe('/d/model.obj');
  });

  it('reconstruct maps a native error', async () => {
    mocks.native = makeNative({
      reconstruct: vi.fn(async () => {
        throw { code: 'ERR_RECONSTRUCTION_FAILED', message: 'photogrammetry died' };
      }),
    });
    const err = await capture.reconstruct().catch((e) => e);
    expect(err.code).toBe('ERR_RECONSTRUCTION_FAILED');
  });

  it('cancel delegates to the native module', async () => {
    const native = makeNative();
    mocks.native = native;
    await capture.cancel();
    expect(native.cancel).toHaveBeenCalledOnce();
  });

  it('event subscriptions delegate to the native emitter with the right event name', () => {
    const native = makeNative();
    mocks.native = native;
    const listener = () => {};
    capture.addCaptureStateListener(listener);
    capture.addReconstructionProgressListener(listener);
    expect(native.addListener).toHaveBeenCalledWith('onCaptureStateChange', listener);
    expect(native.addListener).toHaveBeenCalledWith('onReconstructionProgress', listener);
  });

  it('isPhotoCaptureSupported returns the native boolean and swallows throws', async () => {
    mocks.native = makeNative({ isPhotoCaptureSupported: vi.fn(async () => false) });
    await expect(capture.isPhotoCaptureSupported()).resolves.toBe(false);
    mocks.native = makeNative({
      isPhotoCaptureSupported: vi.fn(async () => {
        throw new Error('bridge exploded');
      }),
    });
    await expect(capture.isPhotoCaptureSupported()).resolves.toBe(false);
    mocks.native = makeNative();
    await expect(capture.isPhotoCaptureSupported()).resolves.toBe(true);
  });

  it('startPhotoCapture resolves the native bundle result', async () => {
    mocks.native = makeNative();
    await expect(capture.startPhotoCapture()).resolves.toEqual(PHOTO_RESULT);
  });

  it('startPhotoCapture forwards the mode and defaults to solo', async () => {
    const native = makeNative();
    mocks.native = native;
    await capture.startPhotoCapture({ mode: 'helper' });
    await capture.startPhotoCapture();
    expect(native.startPhotoCapture).toHaveBeenNthCalledWith(1, { mode: 'helper' });
    expect(native.startPhotoCapture).toHaveBeenNthCalledWith(2, { mode: 'solo' });
  });

  it('addPhotoCaptureStatsListener subscribes to onPhotoCaptureStats', () => {
    const native = makeNative();
    mocks.native = native;
    const listener = () => {};
    capture.addPhotoCaptureStatsListener(listener);
    expect(native.addListener).toHaveBeenCalledWith('onPhotoCaptureStats', listener);
  });

  it('startPhotoCapture maps cancel and camera-denied errors to typed codes', async () => {
    mocks.native = makeNative({
      startPhotoCapture: vi.fn(async () => {
        throw { code: 'ERR_CAPTURE_CANCELLED', message: 'The capture session was cancelled.' };
      }),
    });
    await expect(capture.startPhotoCapture()).rejects.toMatchObject({
      code: 'ERR_CAPTURE_CANCELLED',
    });
    mocks.native = makeNative({
      startPhotoCapture: vi.fn(async () => {
        throw { code: 'ERR_CAPTURE_CAMERA_DENIED', message: 'Camera access is denied.' };
      }),
    });
    await expect(capture.startPhotoCapture()).rejects.toMatchObject({
      code: 'ERR_CAPTURE_CAMERA_DENIED',
    });
  });

  it('startSilhouetteCapture forwards the leg and resolves the bundle result', async () => {
    const native = makeNative();
    mocks.native = native;
    await expect(capture.startSilhouetteCapture({ leg: 'R' })).resolves.toEqual(SILHOUETTE_RESULT);
    expect(native.startSilhouetteCapture).toHaveBeenCalledWith({ leg: 'R' });
  });

  it('startSilhouetteCapture maps the switch-to-manual rejection to its code', async () => {
    mocks.native = makeNative({
      startSilhouetteCapture: vi.fn(async () => {
        throw { code: 'ERR_CAPTURE_SWITCH_TO_MANUAL', message: 'Switching to hand measurement.' };
      }),
    });
    await expect(capture.startSilhouetteCapture({ leg: 'L' })).rejects.toMatchObject({
      code: 'ERR_CAPTURE_SWITCH_TO_MANUAL',
    });
  });

  it('addSilhouetteStatsListener subscribes to onSilhouetteStats', () => {
    const native = makeNative();
    mocks.native = native;
    const listener = () => {};
    capture.addSilhouetteStatsListener(listener);
    expect(native.addListener).toHaveBeenCalledWith('onSilhouetteStats', listener);
  });
});
