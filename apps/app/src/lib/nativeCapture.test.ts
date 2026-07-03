import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveCaptureAvailability } from './nativeCapture';

describe('resolveCaptureAvailability (pure)', () => {
  it('is supported on iOS when the native layer says the device is capable', () => {
    expect(resolveCaptureAvailability('ios', true)).toEqual({ supported: true, reason: 'ok' });
  });

  it('blocks on iOS when the device is not capable (no LiDAR / iOS < 17 / no module)', () => {
    expect(resolveCaptureAvailability('ios', false)).toEqual({
      supported: false,
      reason: 'device',
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
}));

import { getCaptureAvailability } from './nativeCapture';

afterEach(() => {
  mocks.os = 'ios';
  mocks.nativeSupported = true;
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

  it('platform-blocked on Android even if native somehow reports capable', async () => {
    mocks.os = 'android';
    mocks.nativeSupported = true;
    await expect(getCaptureAvailability()).resolves.toEqual({
      supported: false,
      reason: 'platform',
    });
  });
});
