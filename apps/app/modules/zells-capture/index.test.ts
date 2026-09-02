import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureError, CaptureUnavailableError } from './src/errors';
import type { ZellsCaptureNativeModule } from './src/types';

// A mutable holder so each test can flip the native module between "absent"
// (null) and a fake implementation. Hoisted so the vi.mock factory below can
// close over it (vi.mock is hoisted above imports).
const mocks = vi.hoisted(() => ({
  native: null as ZellsCaptureNativeModule | null,
}));

// Mock the single boundary file. The public wrapper (index.ts) is then a pure
// function of `ZellsCaptureNative`, and no native runtime is needed.
vi.mock('./src/native', () => ({
  get ZellsCaptureNative() {
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
    expect(() => stateSub.remove()).not.toThrow();
    expect(() => progressSub.remove()).not.toThrow();
  });
});

describe('when the native module is present', () => {
  const makeNative = (over: Partial<ZellsCaptureNativeModule> = {}): ZellsCaptureNativeModule => ({
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
});
