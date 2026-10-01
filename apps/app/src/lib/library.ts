/**
 * Scan library logic: turns per-leg scan rows into the left + right scan
 * sessions the Library tab shows. Pure, so it is tested in node
 * (library.test.ts) and screens stay layout plus hook calls.
 *
 * A session is the rows sharing a pair_id (supabase/migrations/0010); a row
 * with no pair_id is a session of one leg.
 */

import type { MeasurementKey, Measurements, ScanStatus } from '@forms/shared';

import type { Leg } from './upload';

export interface Scan {
  id: string;
  leg: Leg;
  status: ScanStatus;
  /** Shared by both legs of one session; null for a single-leg scan. */
  pairId: string | null;
  createdAt: string;
  /** Pipeline step that failed (scans.failed_step, migration 0013); null when
   * not failed or the step is unknown. */
  failedStep: FailedStep | null;
}

/** Values of scans.failed_step (supabase/migrations/0013). */
export const FAILED_STEPS = ['reconstructing', 'measuring'] as const;
export type FailedStep = (typeof FAILED_STEPS)[number];

/** Narrows a raw column value; anything unrecognised reads as unknown (null). */
export function toFailedStep(value: unknown): FailedStep | null {
  return FAILED_STEPS.find((step) => step === value) ?? null;
}

export interface ScanSession {
  /** pairId, or the lone scan's id for an unpaired row. Route param for the detail screen. */
  key: string;
  left: Scan | null;
  right: Scan | null;
  /** Earliest leg's capture time: when the session started. */
  createdAt: string;
}

/** What the whole session amounts to, derived from both legs. Order matters
 * in sessionStatus below: one failed leg means a rescan regardless of the other. */
export type SessionStatus =
  /** Both legs measured: a pair order can use it. */
  | 'ready'
  /** At least one leg is still uploading or being measured. */
  | 'processing'
  /** A leg failed its checks and must be scanned again. */
  | 'needs_rescan'
  /** Only one leg was captured. Still orderable as a single guard once ready. */
  | 'one_leg';

export function sessionKey(scan: Scan): string {
  return scan.pairId ?? scan.id;
}

/** Group rows into sessions, newest first. Input order does not matter. If a
 * pair somehow holds two rows for one leg (the DB unique index forbids it),
 * the newer row wins. */
export function groupScanSessions(scans: readonly Scan[]): ScanSession[] {
  const byKey = new Map<string, ScanSession>();
  for (const scan of scans) {
    const key = sessionKey(scan);
    const session = byKey.get(key) ?? { key, left: null, right: null, createdAt: scan.createdAt };
    const slot = scan.leg === 'L' ? 'left' : 'right';
    const existing = session[slot];
    if (!existing || existing.createdAt < scan.createdAt) {
      session[slot] = scan;
    }
    if (scan.createdAt < session.createdAt) {
      session.createdAt = scan.createdAt;
    }
    byKey.set(key, session);
  }
  return [...byKey.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function sessionLegs(session: ScanSession): Scan[] {
  return [session.left, session.right].filter((scan): scan is Scan => scan !== null);
}

export function sessionStatus(session: ScanSession): SessionStatus {
  const legs = sessionLegs(session);
  if (legs.some((scan) => scan.status === 'failed')) {
    return 'needs_rescan';
  }
  if (legs.some((scan) => scan.status !== 'ready')) {
    return 'processing';
  }
  return legs.length === 2 ? 'ready' : 'one_leg';
}

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  ready: 'Ready to order',
  processing: 'Measuring',
  needs_rescan: 'Failed, rescan needed',
  one_leg: 'One leg only',
};

export const SCAN_STATUS_LABEL: Record<ScanStatus, string> = {
  capturing: 'Capturing',
  uploaded: 'Uploaded',
  processing: 'Measuring',
  ready: 'Measured',
  failed: 'Failed, rescan needed',
};

export const LEG_LABEL: Record<Leg, string> = { L: 'Left leg', R: 'Right leg' };

/** Rescan guidance for a failed leg, keyed by the step that failed. */
export const FAILED_STEP_GUIDANCE: Record<FailedStep, string> = {
  reconstructing: 'No 3D model. Rescan in even light, walking all the way around the leg.',
  measuring: 'Could not measure. Rescan with the leg bare from ankle to knee.',
};

const GENERIC_RESCAN_GUIDANCE =
  'Measurements failed our checks. Rescan in good light, walking a full circle.';

export function failedStepGuidance(step: FailedStep | null): string {
  return step ? FAILED_STEP_GUIDANCE[step] : GENERIC_RESCAN_GUIDANCE;
}

/** Legs a checkout may include: measured ('ready') and holding a validated
 * measurement row. The server re-checks both (scan_not_orderable). */
export function orderableLegs(
  session: ScanSession,
  measurementsByScan: ReadonlyMap<string, Measurements>,
): Scan[] {
  return sessionLegs(session).filter(
    (scan) => scan.status === 'ready' && measurementsByScan.has(scan.id),
  );
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

export interface MeasurementRow {
  scanId: string;
  values: Measurements;
  createdAt: string;
}

/** Newest row per scan. Callers pass validated rows only: an unvalidated value
 * never reaches the screen (root CLAUDE.md gotcha 7). */
export function latestMeasurements(rows: readonly MeasurementRow[]): Map<string, Measurements> {
  const newest = new Map<string, MeasurementRow>();
  for (const row of rows) {
    const current = newest.get(row.scanId);
    if (!current || current.createdAt < row.createdAt) {
      newest.set(row.scanId, row);
    }
  }
  return new Map([...newest].map(([scanId, row]) => [scanId, row.values]));
}

export const SLICES = ['S1', 'S2', 'S3', 'S4'] as const;
export const SLICE_DIMS = ['ISW', 'ISD', 'ICW', 'ICD', 'OW', 'OD'] as const;

/** Schema key for a slice/dimension cell, typed against the frozen contract so
 * a restated name that does not exist is a compile error. */
export function sliceKey(
  slice: (typeof SLICES)[number],
  dim: (typeof SLICE_DIMS)[number],
): MeasurementKey {
  return `${slice}_${dim}`;
}

/** Millimetres to one decimal, the precision the extraction reports. */
export function formatMm(value: number): string {
  return `${value.toFixed(1)} mm`;
}

/** "28 Aug 2026". Fixed locale so the library reads the same on every device. */
export function formatSessionDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** User-facing message for a failed delete. 23514 is the RPC refusing a scan
 * that is on an order (supabase/migrations/0011). */
export function deleteErrorMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '23514') {
    return 'This scan is on an order, so it is kept until the order is done.';
  }
  return 'Could not delete this scan. Check your connection and try again.';
}
