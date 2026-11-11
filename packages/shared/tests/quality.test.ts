import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VALUE_SOURCES, validateMeasurementQuality } from '../src/index.js';
import { MEASUREMENT_KEYS } from '../src/measurements.js';

const dir = join(import.meta.dirname, 'fixtures', 'measurement-quality-v1');
const load = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Record<string, any>;
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const base = () => load('valid-optional-tape.json');

describe('measurement-quality fixtures', () => {
  it('has valid and invalid fixtures', () => {
    expect(files.filter((f) => f.startsWith('valid-')).length).toBeGreaterThanOrEqual(2);
    expect(files.filter((f) => f.startsWith('invalid-')).length).toBeGreaterThanOrEqual(10);
  });
  for (const f of files.filter((x) => x.startsWith('valid-') || x.startsWith('invalid-'))) {
    it(f, () => {
      const errors = validateMeasurementQuality(load(f));
      if (f.startsWith('valid-')) expect(errors).toEqual([]);
      else expect(errors.length).toBeGreaterThan(0);
    });
  }
});

describe('validateMeasurementQuality rules', () => {
  const has = (v: unknown, prefix: string) =>
    validateMeasurementQuality(v).some((e) => e.startsWith(prefix));

  it('exposes the value sources', () => {
    expect(VALUE_SOURCES).toEqual(['observed', 'inferred', 'manual', 'adjusted']);
  });

  it('rejects non-objects and unknown keys', () => {
    expect(validateMeasurementQuality(null)).toEqual(['(root): expected an object']);
    const a = base();
    a.extra = 1;
    expect(has(a, '(root).extra')).toBe(true);
    const b = base();
    b.values.S1_OW.extra = 1;
    expect(has(b, 'values.S1_OW.extra')).toBe(true);
    const c = base();
    c.action.extra = 1;
    expect(has(c, 'action.extra')).toBe(true);
  });

  it('requires exactly the measurement keys in values', () => {
    expect(MEASUREMENT_KEYS.length).toBe(25);
    const a = base();
    delete a.values.S3_ICW;
    expect(has(a, 'values.S3_ICW')).toBe(true);
    const b = base();
    b.values.S9_OW = { source: 'observed', sigma_mm: 1 };
    expect(has(b, 'values.S9_OW')).toBe(true);
  });

  it('checks source and sigma_mm', () => {
    const a = base();
    a.values.S1_OW.source = 'scan';
    expect(has(a, 'values.S1_OW.source')).toBe(true);
    for (const s of [0, -1, 1000.01, Number.NaN, '3']) {
      const m = base();
      m.values.S1_OW.sigma_mm = s;
      expect(has(m, 'values.S1_OW.sigma_mm')).toBe(true);
    }
    const ok = base();
    ok.values.S1_OW.sigma_mm = 1000;
    expect(validateMeasurementQuality(ok)).toEqual([]);
  });

  it('checks header, verdict and ratio', () => {
    for (const [k, v] of [
      ['format', 'x'],
      ['version', 2],
      ['verdict', 'fail'],
      ['worst_ratio', -0.1],
    ] as const) {
      const m = base();
      m[k] = v;
      expect(has(m, k)).toBe(true);
    }
  });

  it('ties worst_key to worst_ratio', () => {
    const a = base();
    a.worst_key = null;
    expect(has(a, 'worst_key')).toBe(true);
    const b = base();
    b.worst_ratio = 0;
    expect(has(b, 'worst_key')).toBe(true);
    const c = base();
    c.worst_key = 'S1_ISW';
    expect(has(c, 'worst_key')).toBe(true);
    const d = base();
    d.worst_ratio = 0;
    d.worst_key = null;
    expect(validateMeasurementQuality(d)).toEqual([]);
  });

  it('checks tolerances_mm', () => {
    const a = base();
    a.tolerances_mm.S9_OW = 6;
    expect(has(a, 'tolerances_mm.S9_OW')).toBe(true);
    const b = base();
    b.tolerances_mm.S1_OW = 0;
    expect(has(b, 'tolerances_mm.S1_OW')).toBe(true);
  });

  it('ties action to verdict', () => {
    const a = base();
    a.verdict = 'none';
    expect(has(a, 'action')).toBe(true);
    const b = base();
    b.action = null;
    expect(has(b, 'action')).toBe(true);
    const c = base();
    c.action = { kind: 'tape', key: 'S1_ISW' };
    expect(has(c, 'action.key')).toBe(true);
    const d = base();
    d.verdict = 'none';
    d.action = null;
    expect(validateMeasurementQuality(d)).toEqual([]);
  });
});
