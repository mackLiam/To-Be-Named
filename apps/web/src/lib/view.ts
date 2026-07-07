/**
 * Presentation-pure helpers for the admin panel. No framework imports, so the
 * server components stay thin adapters and all the branching (status tone,
 * error summary, grouping the 25 measurement values by slice) lives here where
 * it is unit tested. Nothing in this file does IO.
 */

import { MEASUREMENT_KEYS, type MeasurementKey } from '@zells/shared';

import type { GateResult, JobError } from './types';

// ---------------------------------------------------------------------------
// Job status badges.
// ---------------------------------------------------------------------------

export type StatusTone = 'neutral' | 'progress' | 'good' | 'warn' | 'bad';

export interface StatusMeta {
  label: string;
  tone: StatusTone;
}

/**
 * Queue status -> human label + a tone the UI maps to a small text badge.
 * Tones are semantic, not colors: the CSS decides the exact navy/orange/danger
 * treatment so contrast stays a single decision.
 */
export const JOB_STATUS_META: Record<string, StatusMeta> = {
  pending: { label: 'Pending', tone: 'neutral' },
  running: { label: 'Running', tone: 'progress' },
  succeeded: { label: 'Succeeded', tone: 'good' },
  failed: { label: 'Failed', tone: 'warn' },
  dead_letter: { label: 'Dead letter', tone: 'bad' },
};

export function jobStatusMeta(status: string): StatusMeta {
  return JOB_STATUS_META[status] ?? { label: status, tone: 'neutral' };
}

// ---------------------------------------------------------------------------
// Formatting.
// ---------------------------------------------------------------------------

/** First 8 chars of a uuid, enough to scan a table by eye. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Compact, deterministic UTC timestamp (YYYY-MM-DD HH:MM UTC). UTC on purpose:
 * an internal ops tool wants one unambiguous clock, and it keeps the output
 * stable across whatever timezone the server or a test runner sits in.
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) {
    return '-';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

function truncate(text: string, maxLen: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) {
    return trimmed;
  }
  // Reserve one char for the ellipsis-as-period-marker (plain '...', no unicode).
  return `${trimmed.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

/**
 * One-line error summary for the queue table. Prefers the human message the
 * worker wrote; falls back to a gate-failure count; empty string when the job
 * carries no error at all.
 */
export function summarizeJobError(error: JobError | null | undefined, maxLen = 80): string {
  if (!error) {
    return '';
  }
  if (error.message && error.message.trim()) {
    return truncate(error.message, maxLen);
  }
  const failed = (error.gates ?? []).filter((gate) => !gate.ok);
  if (failed.length > 0) {
    return `${failed.length} plausibility gate${failed.length === 1 ? '' : 's'} failed`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Grouping the 25 measurement values for the triage view.
// ---------------------------------------------------------------------------

export const SLICES = ['S1', 'S2', 'S3', 'S4'] as const;
export type Slice = (typeof SLICES)[number];

export const DIMS = ['ISW', 'ISD', 'ICW', 'ICD', 'OW', 'OD'] as const;
export type Dim = (typeof DIMS)[number];

/**
 * Where each slice sits, measured up from the bottom of the ankle
 * (DESIGN.md gotcha 2: S1 is nearest the ankle, S4 nearest the knee).
 */
export const SLICE_POSITION: Record<Slice, string> = {
  S1: '20% (nearest ankle)',
  S2: '40%',
  S3: '60%',
  S4: '80% (nearest knee)',
};

export interface MeasurementCell {
  key: MeasurementKey;
  dim: Dim;
  value: number | null;
  gate: GateResult | null;
  outOfRange: boolean;
}

export interface SliceGroup {
  slice: Slice;
  position: string;
  cells: MeasurementCell[];
}

export interface LegLengthEntry {
  key: 'Leg_Length';
  value: number | null;
  gate: GateResult | null;
  outOfRange: boolean;
}

export interface GroupedMeasurements {
  legLength: LegLengthEntry;
  slices: SliceGroup[];
  /** How many of the 25 values are present (non-null). */
  presentCount: number;
  /** Gates whose key does not map to a known measurement variable. */
  unmatchedGates: GateResult[];
}

function gateIndex(gates: GateResult[]): Map<string, GateResult> {
  const map = new Map<string, GateResult>();
  for (const gate of gates) {
    // Last write wins; the worker emits at most one gate per key.
    map.set(gate.key, gate);
  }
  return map;
}

/**
 * Fold a raw 25-variable payload plus any gate results into a slice-by-slice
 * structure the triage table renders directly. Reads everything defensively:
 * values is JSONB and any key may be missing.
 */
export function groupMeasurements(
  values: Partial<Record<MeasurementKey, number>> | null | undefined,
  gates: GateResult[] = [],
): GroupedMeasurements {
  const byKey = gateIndex(gates);
  const known = new Set<string>(MEASUREMENT_KEYS);

  const read = (key: MeasurementKey) => {
    const raw = values?.[key];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    const gate = byKey.get(key) ?? null;
    return { value, gate, outOfRange: gate != null && gate.ok === false };
  };

  const legRead = read('Leg_Length');
  const legLength: LegLengthEntry = { key: 'Leg_Length', ...legRead };

  let presentCount = legLength.value != null ? 1 : 0;

  const slices: SliceGroup[] = SLICES.map((slice) => ({
    slice,
    position: SLICE_POSITION[slice],
    cells: DIMS.map((dim) => {
      const key = `${slice}_${dim}` as MeasurementKey;
      const cell = read(key);
      if (cell.value != null) {
        presentCount += 1;
      }
      return { key, dim, ...cell };
    }),
  }));

  const unmatchedGates = gates.filter((gate) => !known.has(gate.key));

  return { legLength, slices, presentCount, unmatchedGates };
}
