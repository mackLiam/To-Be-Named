import { describe, expect, it } from 'vitest';

import { isCaptureSupported, resolveCaptureMode } from './capture';

describe('isCaptureSupported', () => {
  it('supports iOS when LiDAR is unknown (no native module yet)', () => {
    expect(isCaptureSupported('ios')).toBe(true);
    expect(isCaptureSupported('ios', undefined)).toBe(true);
  });

  it('supports iOS when LiDAR is confirmed present', () => {
    expect(isCaptureSupported('ios', true)).toBe(true);
  });

  it('blocks iOS when LiDAR is confirmed absent', () => {
    expect(isCaptureSupported('ios', false)).toBe(false);
  });

  it('blocks android regardless of LiDAR', () => {
    expect(isCaptureSupported('android')).toBe(false);
    expect(isCaptureSupported('android', true)).toBe(false);
  });

  it('blocks web regardless of LiDAR', () => {
    expect(isCaptureSupported('web')).toBe(false);
    expect(isCaptureSupported('web', true)).toBe(false);
  });
});

describe('resolveCaptureMode', () => {
  it('prefers object capture when both are supported', () => {
    expect(resolveCaptureMode(true, true)).toBe('object');
    expect(resolveCaptureMode(true, false)).toBe('object');
  });

  it('routes to photos when only photo capture is supported (iPhone 16, no LiDAR)', () => {
    expect(resolveCaptureMode(false, true)).toBe('photos');
  });

  it('returns null when neither is supported', () => {
    expect(resolveCaptureMode(false, false)).toBeNull();
  });
});
