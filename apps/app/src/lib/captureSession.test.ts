import { describe, expect, it } from 'vitest';

import {
  allocateScanId,
  canCapture,
  createCaptureSession,
  currentLeg,
  isSessionComplete,
  markUploaded,
} from './captureSession';

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

describe('captureSession', () => {
  it('starts on the left leg with a fresh pair id and nothing allocated', () => {
    const session = createCaptureSession(ids());
    expect(session.pairId).toBe('id-1');
    expect(currentLeg(session)).toBe('L');
    expect(canCapture(session, 'L')).toBe(true);
    expect(canCapture(session, 'R')).toBe(false);
    expect(session.scanIds).toEqual({ L: null, R: null });
    expect(isSessionComplete(session)).toBe(false);
  });

  it('runs L then R, then completes with both scan ids and the same pair id', () => {
    const newId = ids();
    let session = createCaptureSession(newId);
    const left = allocateScanId(session, 'L', newId);
    session = markUploaded(left.session, 'L', left.scanId);
    expect(currentLeg(session)).toBe('R');

    const right = allocateScanId(session, 'R', newId);
    session = markUploaded(right.session, 'R', right.scanId);
    expect(isSessionComplete(session)).toBe(true);
    expect(currentLeg(session)).toBeNull();
    expect(session).toEqual({
      pairId: 'id-1',
      scanIds: { L: 'id-2', R: 'id-3' },
      uploaded: { L: true, R: true },
    });
  });

  it('reuses a leg scan id across repeated allocations (retry and recapture)', () => {
    const newId = ids();
    const first = allocateScanId(createCaptureSession(newId), 'L', newId);
    const second = allocateScanId(first.session, 'L', newId);
    expect(second.scanId).toBe(first.scanId);
    expect(second.session).toBe(first.session);
  });

  it('never allows recapturing an uploaded leg', () => {
    const newId = ids();
    const { session, scanId } = allocateScanId(createCaptureSession(newId), 'L', newId);
    const after = markUploaded(session, 'L', scanId);
    expect(canCapture(after, 'L')).toBe(false);
    const done = markUploaded(after, 'R', 'x');
    expect(canCapture(done, 'L')).toBe(false);
    expect(canCapture(done, 'R')).toBe(false);
  });

  it('does not mutate the input session', () => {
    const newId = ids();
    const session = createCaptureSession(newId);
    allocateScanId(session, 'L', newId);
    markUploaded(session, 'L', 'x');
    expect(session.scanIds).toEqual({ L: null, R: null });
    expect(session.uploaded).toEqual({ L: false, R: false });
  });
});
