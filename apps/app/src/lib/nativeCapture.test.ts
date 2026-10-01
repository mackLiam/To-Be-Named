import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveCaptureAvailability } from './nativeCapture';

describe('resolveCaptureAvailability (pure)', () => {
  it('is supported on iOS when the native layer says the device is capable', () => {
    expect(resolveCaptureAvailability('ios', true)).toEqual({
      supported: true,
      reason: 'ok',
      mode: 'object',
    });
  });

  it('blocks on iOS when the device is not capable (no LiDAR / iOS < 17)', () => {
    expect(resolveCaptureAvailability('ios', false)).toEqual({
      supported: false,
      reason: 'device',
      mode: null,
    });
  });

  it('reports a missing native module separately from an incapable device', () => {
    expect(resolveCaptureAvailability('ios', false, false)).toEqual({
      supported: false,
      reason: 'module',
      mode: null,
    });
    // Module missing wins even if the native layer somehow claims support: a
    // module that is not linked cannot have answered truthfully.
    expect(resolveCaptureAvailability('ios', true, false)).toEqual({
      supported: false,
      reason: 'module',
      mode: null,
    });
  });

  it('blocks non-iOS platforms regardless of the native result', () => {
    expect(resolveCaptureAvailability('android', true)).toEqual({
      supported: false,
      reason: 'platform',
      mode: null,
    });
    expect(resolveCaptureAvailability('web', true)).toEqual({
      supported: false,
      reason: 'platform',
      mode: null,
    });
  });
});

// getCaptureAvailability wires Platform + the native module onto the pure
// combiner. Mock both so it runs in node without a device.
const mocks = vi.hoisted(() => ({
  os: 'ios' as string,
  nativeSupported: true as boolean,
  moduleLinked: true as boolean,
  photoSupported: false as boolean,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mocks.os;
    },
  },
}));

vi.mock('../../modules/forms-capture', () => ({
  isSupported: vi.fn(async () => mocks.nativeSupported),
  isNativeModuleAvailable: vi.fn(() => mocks.moduleLinked),
  isPhotoCaptureSupported: vi.fn(async () => mocks.photoSupported),
}));

import { getCaptureAvailability } from './nativeCapture';

afterEach(() => {
  mocks.os = 'ios';
  mocks.nativeSupported = true;
  mocks.moduleLinked = true;
  mocks.photoSupported = false;
});

describe('getCaptureAvailability (wired)', () => {
  it('supported on a capable iOS device', async () => {
    mocks.os = 'ios';
    mocks.nativeSupported = true;
    await expect(getCaptureAvailability()).resolves.toEqual({
      supported: true,
      reason: 'ok',
      mode: 'object',
    });
  });

  it('device-blocked on iOS when native isSupported resolves false', async () => {
    mocks.os = 'ios';
    mocks.nativeSupported = false;
    await expect(getCaptureAvailability()).resolves.toEqual({
      supported: false,
      reason: 'device',
      mode: null,
    });
  });

  it('module-blocked on iOS when the native module is not linked (Expo Go)', async () => {
    mocks.os = 'ios';
    mocks.moduleLinked = false;
    mocks.nativeSupported = false;
    await expect(getCaptureAvailability()).resolves.toEqual({
      supported: false,
      reason: 'module',
      mode: null,
    });
  });

  it('platform-blocked on Android even if native somehow reports capable', async () => {
    mocks.os = 'android';
    mocks.nativeSupported = true;
    await expect(getCaptureAvailability()).resolves.toEqual({
      supported: false,
      reason: 'platform',
      mode: null,
    });
  });

  it('routes a non-LiDAR ARKit iPhone to photo capture', async () => {
    mocks.nativeSupported = false;
    mocks.photoSupported = true;
    await expect(getCaptureAvailability()).resolves.toEqual({
      supported: true,
      reason: 'ok',
      mode: 'photos',
    });
  });
});

describe('resolveCaptureAvailability: mode routing', () => {
  it('prefers ObjectCapture when both flows are available', () => {
    expect(resolveCaptureAvailability('ios', true, true, true)).toEqual({
      supported: true,
      reason: 'ok',
      mode: 'object',
    });
  });

  it('falls back to photos without ObjectCapture', () => {
    expect(resolveCaptureAvailability('ios', false, true, true)).toEqual({
      supported: true,
      reason: 'ok',
      mode: 'photos',
    });
  });

  it('keeps device when neither flow is available', () => {
    expect(resolveCaptureAvailability('ios', false, true, false)).toMatchObject({
      reason: 'device',
      mode: null,
    });
  });

  it('platform and module gates still win over photo support', () => {
    expect(resolveCaptureAvailability('android', false, true, true).reason).toBe('platform');
    expect(resolveCaptureAvailability('ios', false, false, true).reason).toBe('module');
  });
});
