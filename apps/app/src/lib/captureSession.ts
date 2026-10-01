/**
 * Two-leg capture session: one pair id, left leg then right leg.
 *
 * Pure and immutable so the order and identity rules are testable without a
 * device. CaptureFlowController (src/hooks/useCaptureFlow.ts) holds one of these
 * and consults it before each capture and upload.
 *
 * Identity rules, from the partial unique index on scans (pair_id, leg):
 * - A leg's scan id is allocated once and reused for every upload retry and
 *   every recapture of that leg until it uploads, so a pair never holds two
 *   rows for one leg.
 * - Once a leg uploads it is never captured again in the same pair.
 */

import type { Leg } from './upload';

export const LEG_ORDER: readonly Leg[] = ['L', 'R'];

export interface CaptureSession {
  pairId: string;
  scanIds: Record<Leg, string | null>;
  uploaded: Record<Leg, boolean>;
}

export function createCaptureSession(newId: () => string): CaptureSession {
  return {
    pairId: newId(),
    scanIds: { L: null, R: null },
    uploaded: { L: false, R: false },
  };
}

/** The leg to capture now, or null once both legs are uploaded. */
export function currentLeg(session: CaptureSession): Leg | null {
  return LEG_ORDER.find((leg) => !session.uploaded[leg]) ?? null;
}

/** Only the current leg may be captured; uploaded legs and out-of-order legs may not. */
export function canCapture(session: CaptureSession, leg: Leg): boolean {
  return currentLeg(session) === leg;
}

export function isSessionComplete(session: CaptureSession): boolean {
  return currentLeg(session) === null;
}

/** The leg's scan id, allocating it on first use. */
export function allocateScanId(
  session: CaptureSession,
  leg: Leg,
  newId: () => string,
): { session: CaptureSession; scanId: string } {
  const existing = session.scanIds[leg];
  if (existing) {
    return { session, scanId: existing };
  }
  const scanId = newId();
  return { session: { ...session, scanIds: { ...session.scanIds, [leg]: scanId } }, scanId };
}

export function markUploaded(session: CaptureSession, leg: Leg, scanId: string): CaptureSession {
  return {
    ...session,
    scanIds: { ...session.scanIds, [leg]: scanId },
    uploaded: { ...session.uploaded, [leg]: true },
  };
}
