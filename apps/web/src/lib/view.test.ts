import { MEASUREMENT_KEYS } from '@zells/shared';
import { describe, expect, it } from 'vitest';

import type { GateResult } from './types';
import {
  DIMS,
  formatDateTime,
  groupMeasurements,
  jobStatusMeta,
  shortId,
  SLICES,
  summarizeJobError,
} from './view';

describe('jobStatusMeta', () => {
  it('maps known queue states to a label and tone', () => {
    expect(jobStatusMeta('dead_letter')).toEqual({ label: 'Dead letter', tone: 'bad' });
    expect(jobStatusMeta('succeeded').tone).toBe('good');
    expect(jobStatusMeta('running').tone).toBe('progress');
  });

  it('falls back to the raw value with a neutral tone for anything unknown', () => {
    expect(jobStatusMeta('weird')).toEqual({ label: 'weird', tone: 'neutral' });
  });
});

describe('shortId', () => {
  it('takes the first 8 chars of a uuid', () => {
    expect(shortId('00000000-0000-4000-8000-000000000002')).toBe('00000000');
  });

  it('leaves short ids untouched', () => {
    expect(shortId('abc')).toBe('abc');
  });
});

describe('formatDateTime', () => {
  it('renders a fixed UTC string regardless of runner timezone', () => {
    expect(formatDateTime('2026-07-01T18:52:00Z')).toBe('2026-07-01 18:52 UTC');
  });

  it('returns a dash for null or unparseable input', () => {
    expect(formatDateTime(null)).toBe('-');
    expect(formatDateTime('not-a-date')).toBe('-');
  });
});

describe('summarizeJobError', () => {
  it('is empty when there is no error', () => {
    expect(summarizeJobError(null)).toBe('');
    expect(summarizeJobError({})).toBe('');
  });

  it('prefers the worker message', () => {
    expect(summarizeJobError({ message: 'Onshape regeneration timed out.' })).toBe(
      'Onshape regeneration timed out.',
    );
  });

  it('truncates a long message with a plain ellipsis', () => {
    const long = 'x'.repeat(200);
    const summary = summarizeJobError({ message: long }, 20);
    expect(summary.length).toBe(20);
    expect(summary.endsWith('...')).toBe(true);
  });

  it('falls back to a gate-failure count when there is no message', () => {
    const gates: GateResult[] = [
      { key: 'S1_ISW', value: 12, min: 30, max: 90, ok: false },
      { key: 'S4_OD', value: 210, min: 40, max: 140, ok: false },
      { key: 'S2_OW', value: 78, min: 40, max: 140, ok: true },
    ];
    expect(summarizeJobError({ gates })).toBe('2 plausibility gates failed');
  });

  it('uses the singular for one failed gate', () => {
    expect(summarizeJobError({ gates: [{ key: 'S1_ISW', value: 12, ok: false }] })).toBe(
      '1 plausibility gate failed',
    );
  });
});

describe('groupMeasurements', () => {
  it('groups a full payload into Leg_Length plus 4 slices of 6 dims', () => {
    const values: Record<string, number> = {};
    for (const key of MEASUREMENT_KEYS) {
      values[key] = 50;
    }
    const grouped = groupMeasurements(values);

    expect(grouped.legLength.value).toBe(50);
    expect(grouped.slices).toHaveLength(SLICES.length);
    for (const group of grouped.slices) {
      expect(group.cells).toHaveLength(DIMS.length);
      expect(group.cells.map((cell) => cell.dim)).toEqual([...DIMS]);
    }
    expect(grouped.presentCount).toBe(MEASUREMENT_KEYS.length);
    expect(grouped.presentCount).toBe(25);
  });

  it('flags the exact cells that tripped a gate as out of range', () => {
    const gates: GateResult[] = [
      { key: 'S1_ISW', value: 12, min: 30, max: 90, ok: false },
      { key: 'S4_OD', value: 210, min: 40, max: 140, ok: false },
    ];
    const grouped = groupMeasurements({ S1_ISW: 12, S4_OD: 210, S2_OW: 78 }, gates);

    const s1isw = grouped.slices[0]!.cells.find((cell) => cell.dim === 'ISW')!;
    expect(s1isw.key).toBe('S1_ISW');
    expect(s1isw.outOfRange).toBe(true);
    expect(s1isw.gate?.min).toBe(30);

    const s2ow = grouped.slices[1]!.cells.find((cell) => cell.dim === 'OW')!;
    expect(s2ow.outOfRange).toBe(false);
    expect(s2ow.value).toBe(78);
  });

  it('treats missing and non-finite values as null and counts only real ones', () => {
    const grouped = groupMeasurements({ Leg_Length: 265, S1_ISW: 62 });
    expect(grouped.legLength.value).toBe(265);
    expect(grouped.presentCount).toBe(2);
    const s1icd = grouped.slices[0]!.cells.find((cell) => cell.dim === 'ICD')!;
    expect(s1icd.value).toBeNull();
  });

  it('handles a null payload without throwing', () => {
    const grouped = groupMeasurements(null, [{ key: 'S1_ISW', value: null, ok: false }]);
    expect(grouped.legLength.value).toBeNull();
    expect(grouped.presentCount).toBe(0);
    // The gate still marks its cell even with no value payload.
    expect(grouped.slices[0]!.cells[0]!.outOfRange).toBe(true);
  });

  it('surfaces gates whose key is not a known measurement variable', () => {
    const grouped = groupMeasurements(
      {},
      [{ key: 'mystery_dim', value: 1, ok: false }],
    );
    expect(grouped.unmatchedGates).toHaveLength(1);
    expect(grouped.unmatchedGates[0]!.key).toBe('mystery_dim');
  });
});
