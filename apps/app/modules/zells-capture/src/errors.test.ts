import { describe, expect, it } from 'vitest';

import { CaptureError, CaptureUnavailableError, mapNativeError } from './errors';

describe('CaptureError', () => {
  it('carries a code and message and is an Error instance', () => {
    const err = new CaptureError('ERR_RECONSTRUCTION_FAILED', 'boom');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CaptureError);
    expect(err.code).toBe('ERR_RECONSTRUCTION_FAILED');
    expect(err.message).toBe('boom');
  });
});

describe('CaptureUnavailableError', () => {
  it('is a CaptureError with the unavailable code', () => {
    const err = new CaptureUnavailableError('no native module');
    expect(err).toBeInstanceOf(CaptureError);
    expect(err).toBeInstanceOf(CaptureUnavailableError);
    expect(err.code).toBe('ERR_CAPTURE_UNAVAILABLE');
    expect(err.message).toBe('no native module');
  });
});

describe('mapNativeError', () => {
  it('returns an existing CaptureError untouched', () => {
    const original = new CaptureError('ERR_EXPORT_FAILED', 'x');
    expect(mapNativeError(original)).toBe(original);
  });

  it('uses a known stable code directly', () => {
    const mapped = mapNativeError({ code: 'ERR_CAPTURE_CANCELLED', message: 'user left' });
    expect(mapped.code).toBe('ERR_CAPTURE_CANCELLED');
    expect(mapped.message).toBe('user left');
  });

  it('maps each known stable code through', () => {
    const codes = [
      'ERR_CAPTURE_UNSUPPORTED_DEVICE',
      'ERR_CAPTURE_NO_IMAGES',
      'ERR_RECONSTRUCTION_FAILED',
      'ERR_EXPORT_FAILED',
    ] as const;
    for (const code of codes) {
      expect(mapNativeError({ code, message: 'm' }).code).toBe(code);
    }
  });

  it('falls back to keyword matching when the code is the Swift class name', () => {
    expect(mapNativeError({ code: 'CaptureCancelledException' }).code).toBe(
      'ERR_CAPTURE_CANCELLED',
    );
    expect(mapNativeError({ code: 'ReconstructionFailedException' }).code).toBe(
      'ERR_RECONSTRUCTION_FAILED',
    );
    expect(mapNativeError({ code: 'ExportFailedException' }).code).toBe('ERR_EXPORT_FAILED');
  });

  it('classifies by message when there is no useful code', () => {
    expect(mapNativeError(new Error('LiDAR not supported')).code).toBe(
      'ERR_CAPTURE_UNSUPPORTED_DEVICE',
    );
    expect(mapNativeError(new Error('too few images captured')).code).toBe('ERR_CAPTURE_NO_IMAGES');
  });

  it('handles string and unknown throws', () => {
    expect(mapNativeError('something broke').code).toBe('ERR_CAPTURE_UNKNOWN');
    expect(mapNativeError(undefined).code).toBe('ERR_CAPTURE_UNKNOWN');
    expect(mapNativeError(42).code).toBe('ERR_CAPTURE_UNKNOWN');
  });

  it('preserves the original value as cause', () => {
    const raw = { code: 'weird', message: 'odd' };
    expect(mapNativeError(raw).cause).toBe(raw);
  });
});
