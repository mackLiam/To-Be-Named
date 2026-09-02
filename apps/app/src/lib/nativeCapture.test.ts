import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveCaptureAvailability } from './nativeCapture';

describe('resolveCaptureAvailability (pure)', () => {
  it('is supported on iOS when the native layer says the device is capable', () => {
    expect(resolveCaptureAvailability('ios', true)).toEqual({ supported: true, reason: 'ok' });
  });

  it('blocks on iOS when the device is not capable (no LiDAR / iOS < 17)', () => {
    expect(resolveCaptureAvailability('ios', false)).toEqual({
      supported: false,
      reason: 'device',
    });
  });

  it('reports a missing native module separately from an incapable device', () => {
    expect(resolveCaptureAvailability('ios', false, false)).toEqual({
      supported: false,
      reason: 'module',
    });
    // Module missing wins even if the native layer somehow claims support: a
    // module that is not linked cannot have answered truthfully.
    expect(resolveCaptureAvailability('ios', true, false)).toEqual({
      supported: false,
      reason: 'module',
    });
  });

  it('blocks non-iOS platforms regardless of the native result', () => {
    expect(resolveCaptureAvailability('android', true)).toEqual({
      supported: false,
      reason: 'platform',
    });
    expect(resolveCaptureAvailability('web', true)).toEqual({
      supported: false,
      reason: 'platform',
    });
  });
});

// getCaptureAvailability wires Platform + the native module onto the pure
// combiner. Mock both so it runs in node without a device.
const mocks = vi.hoisted(() => ({
  os: 'ios' as string,
  nativeSupported: true as boolean,
  moduleLinked: true as boolean,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return mocks.os;
    },
  },
}));

vi.mock('../../modules/zells-capture', () => ({
  isSupported: vi.fn(async () => mocks.nativeSupported),
  isNativeModuleAvailable: vi.fn(() => mocks.moduleLinked),
}));

import { getCaptureAvailability } from './nativeCapture';

afterEach(() => {
  mocks.os = 'ios';
  mocks.nativeSupported = true;
  mocks.moduleLinked = true;
});

describe('getCaptureAvailability (wired)', () => {
  it('supported on a capable iOS device', async () => {
    mocks.os = 'ios';
    mocks.nativeSupported = true;
    await expect(getCaptureAvailability()).resolves.toEqual({ supported: true, reason: 'ok' });
  });

  it('device-blocked on iOS when native isSupported resolves false', async () => {
    mocks.os = 'ios';
    mocks.nativeSupported = false;
    await expect(getCaptureAvailability()).resolves.toEqual({
      supported: false,
      reason: 'device',
    });
  });

  it('module-blocked on iOS when the native module is not linked (Expo Go)', async () => {
    mocks.os = 'ios';
    mocks.moduleLinked = false;
    mocks.nativeSupported = false;
    await expect(getCaptureAvailability()).resolves.toEqual({
      supported: false,
      reason: 'module',
    });
  });

  it('platform-blocked on Android even if native somehow reports capable', async () => {
    mocks.os = 'android';
    mocks.nativeSupported = true;
    await expect(getCaptureAvailability()).resolves.toEqual({
      supported: false,
      reason: 'platform',
    });
  });
});
