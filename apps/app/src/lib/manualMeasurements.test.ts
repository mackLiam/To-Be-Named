import { MEASUREMENT_KEYS, validateMeasurements, type Measurements } from '@forms/shared';
import { describe, expect, it } from 'vitest';

import { SLICES, sliceKey } from './library';
import {
  ALL_KEYS,
  DERIVED_KEYS,
  MANUAL_KEYS,
  checkField,
  deriveMeasurements,
  diffAgainstScan,
  fieldLabel,
  formatDiff,
  parseMm,
  range,
  sanitizeMmInput,
  sliceHeights,
  validateManual,
  type Values,
} from './manualMeasurements';

/** A leg measured with tape and books: 9 values. */
function entered(): Values {
  const v: Values = { Leg_Length: 392 };
  SLICES.forEach((slice, i) => {
    v[sliceKey(slice, 'OW')] = 61 + i * 14;
    v[sliceKey(slice, 'OD')] = 70 + i * 15;
  });
  return v;
}

function scan(): Measurements {
  const m = { Leg_Length: 390 } as Measurements;
  SLICES.forEach((slice, i) => {
    m[sliceKey(slice, 'OW')] = 60 + i * 14;
    m[sliceKey(slice, 'ISW')] = 27 + i * 6;
    m[sliceKey(slice, 'ICW')] = 33 + i * 8;
    m[sliceKey(slice, 'OD')] = 70 + i * 15;
    m[sliceKey(slice, 'ISD')] = 64 + i * 13;
    m[sliceKey(slice, 'ICD')] = 58 + i * 12;
  });
  return m;
}

describe('keys', () => {
  it('covers exactly the shared contract: 9 measured plus 16 derived', () => {
    expect([...ALL_KEYS]).toEqual([...MEASUREMENT_KEYS]);
    expect(MANUAL_KEYS).toHaveLength(9);
    expect(DERIVED_KEYS).toHaveLength(16);
    expect(new Set([...MANUAL_KEYS, ...DERIVED_KEYS]).size).toBe(25);
  });

  it('labels marks from the ankle up', () => {
    expect(fieldLabel('Leg_Length')).toBe('Leg length');
    expect(fieldLabel('S1_OW')).toBe('Width at mark 1');
    expect(fieldLabel('S4_ICD')).toBe('Inner calf depth at mark 4');
  });
});

describe('sliceHeights', () => {
  it('puts S1..S4 at 20/40/60/80 percent up from the ankle', () => {
    expect(sliceHeights(392)).toEqual({ S1: 78.4, S2: 156.8, S3: 235.2, S4: 313.6 });
  });

  it('rounds to one decimal', () => {
    expect(sliceHeights(333.3).S1).toBe(66.7);
  });
});

describe('input', () => {
  it('sanitizes typing to 3 digits and one decimal', () => {
    expect(sanitizeMmInput('12a3.45')).toBe('123.4');
    expect(sanitizeMmInput('61,5')).toBe('61.5');
    expect(sanitizeMmInput('4567')).toBe('456');
    expect(sanitizeMmInput('61.')).toBe('61.');
    expect(sanitizeMmInput('')).toBe('');
  });

  it('parses mm, null for empty or junk', () => {
    expect(parseMm('61.5')).toBe(61.5);
    expect(parseMm('61,5')).toBe(61.5);
    expect(parseMm('61.')).toBeNull();
    expect(parseMm('')).toBeNull();
    expect(parseMm(undefined)).toBeNull();
    expect(parseMm('6.15')).toBeNull();
  });
});

describe('deriveMeasurements', () => {
  it('estimates symmetric halves with no scan', () => {
    const { values, estimated } = deriveMeasurements({ ...entered(), S1_OW: 61.5 });
    expect(values.S1_ISW).toBe(30.8);
    expect(values.S1_ICW).toBe(30.7);
    expect((values.S1_ISW as number) + (values.S1_ICW as number)).toBeCloseTo(61.5, 6);
    expect(values.S1_ISD).toBe(70);
    expect(values.S1_ICD).toBe(70);
    expect([...estimated].sort()).toEqual([...DERIVED_KEYS].sort());
  });

  it('builds all 25 keys from the 9 measured, and they validate on the shared validator', () => {
    const { values } = deriveMeasurements(entered());
    expect(Object.keys(values).sort()).toEqual([...MEASUREMENT_KEYS].sort());
    const result = validateManual(values);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.measurements)).toEqual([...MEASUREMENT_KEYS]);
      expect(validateMeasurements(result.measurements).valid).toBe(true);
    }
  });

  it('leaves a slice blank until its width or depth is measured', () => {
    const { values, estimated } = deriveMeasurements({ Leg_Length: 392, S1_OW: 60 });
    expect(values.S1_ISW).toBe(30);
    expect(values.S1_ISD).toBeUndefined();
    expect(values.S2_ISW).toBeUndefined();
    expect(estimated).toEqual(['S1_ISW', 'S1_ICW']);
  });

  it('keeps scan values for an unchanged slice and scales the scan split when changed', () => {
    const base = scan();
    const input: Values = Object.fromEntries(MANUAL_KEYS.map((k) => [k, base[k]]));
    input.S2_OW = 74 * 1.1; // 81.4
    const { values, estimated } = deriveMeasurements(input, { base });
    expect(values.S1_ISW).toBe(base.S1_ISW);
    expect(values.S1_ISD).toBe(base.S1_ISD);
    expect(values.S2_ISW).toBe(36.3); // 33 * 1.1
    expect(values.S2_ICW).toBe(45.1); // 81.4 - 36.3, keeps ISW + ICW == OW
    expect(values.S2_ISD).toBe(base.S2_ISD);
    expect(estimated).toEqual(['S2_ISW', 'S2_ICW']);
  });

  it('keeps unrounded scan values exactly when a slice is unchanged', () => {
    const base = { ...scan(), S1_ISW: 27.26, S1_ICW: 32.74 };
    const input: Values = Object.fromEntries(MANUAL_KEYS.map((k) => [k, base[k]]));
    const { values, estimated } = deriveMeasurements(input, { base });
    expect(values.S1_ISW).toBe(27.26);
    expect(values.S1_ICW).toBe(32.74);
    expect(estimated).toEqual([]);
    expect(diffAgainstScan(base, values).every((d) => d.delta === 0)).toBe(true);
  });

  it('lets overrides win and stop counting as estimates', () => {
    const { values, estimated } = deriveMeasurements(entered(), { overrides: { S3_ISW: 40 } });
    expect(values.S3_ISW).toBe(40);
    expect(estimated).not.toContain('S3_ISW');
    expect(estimated).toHaveLength(15);
  });
});

describe('validateManual', () => {
  it('agrees with the shared schema ranges', () => {
    expect(range('Leg_Length')).toEqual({ min: 150, max: 600 });
    expect(range('S1_OW')).toEqual({ min: 30, max: 220 });
  });

  it('returns plain-language per-field errors', () => {
    const { values } = deriveMeasurements({ ...entered(), Leg_Length: 39.2, S2_OD: 300 });
    delete values.S4_OW;
    const result = validateManual(values);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.Leg_Length).toBe(
      'Leg length looks too small. It should be between 150 and 600 mm. Check it is in mm, not cm. Measure again.',
    );
    expect(result.errors.S2_OD).toBe(
      'Depth at mark 2 looks too large. It should be between 30 and 220 mm. Measure again.',
    );
    expect(result.errors.S4_OW).toBe('Enter the width at mark 4 in millimetres.');
    // The shared validator rejects the same object.
    expect(validateMeasurements(values).valid).toBe(false);
  });

  it('checks a single field at the range edges', () => {
    expect(checkField('S1_OW', 30)).toBeNull();
    expect(checkField('S1_OW', 220)).toBeNull();
    expect(checkField('S1_OW', 29.9)).toMatch(/too small/);
    expect(checkField('S1_OW', Number.NaN)).toMatch(/^Enter/);
  });
});

describe('diffAgainstScan', () => {
  it('reports absolute and percent change and flags over 15 percent', () => {
    const base = scan();
    const diffs = diffAgainstScan(base, { ...base, S1_OW: 66, S2_OW: 74 * 1.2, Leg_Length: 390 });
    const byKey = Object.fromEntries(diffs.map((d) => [d.key, d]));
    expect(diffs).toHaveLength(25);
    expect(byKey.Leg_Length).toMatchObject({ delta: 0, percent: 0, big: false });
    expect(byKey.S1_OW).toMatchObject({
      scanned: 60,
      entered: 66,
      delta: 6,
      percent: 10,
      big: false,
    });
    expect(byKey.S2_OW).toMatchObject({ delta: 14.8, percent: 20, big: true });
    expect(formatDiff(byKey.S1_OW!)).toBe('+6.0 mm (+10.0%)');
  });

  it('flags a big decrease and treats exactly 15 percent as not big', () => {
    const base = scan();
    const diffs = diffAgainstScan(base, { S1_OW: 60 * 0.85, S1_OD: 70 * 0.8 });
    expect(diffs.find((d) => d.key === 'S1_OW')).toMatchObject({ percent: -15, big: false });
    const od = diffs.find((d) => d.key === 'S1_OD')!;
    expect(od).toMatchObject({ percent: -20, big: true });
    expect(formatDiff(od)).toBe('-14.0 mm (-20.0%)');
  });
});
