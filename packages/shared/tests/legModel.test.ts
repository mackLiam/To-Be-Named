import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIT_ACTION_KINDS,
  FIT_CHECKS,
  LEG_MODEL_RING_COUNT,
  LEG_MODEL_RING_POINTS,
  validateLegModel,
} from '../src/index.js';

const dir = join(import.meta.dirname, 'fixtures', 'leg-model-v1');
const load = (name: string): Record<string, any> =>
  JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Record<string, any>;
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const base = () => load('valid-optional-tape.json');

describe('leg-model fixtures', () => {
  it('has valid and invalid fixtures', () => {
    expect(files.filter((f) => f.startsWith('valid-')).length).toBeGreaterThanOrEqual(2);
    expect(files.filter((f) => f.startsWith('invalid-')).length).toBeGreaterThanOrEqual(10);
  });
  for (const f of files.filter((x) => x.startsWith('valid-') || x.startsWith('invalid-'))) {
    it(f, () => {
      const errors = validateLegModel(load(f));
      if (f.startsWith('valid-')) expect(errors).toEqual([]);
      else expect(errors.length).toBeGreaterThan(0);
    });
  }
});

describe('validateLegModel rules', () => {
  const has = (v: unknown, prefix: string) => validateLegModel(v).some((e) => e.startsWith(prefix));

  it('exposes the pinned constants', () => {
    expect(LEG_MODEL_RING_COUNT).toBe(21);
    expect(LEG_MODEL_RING_POINTS).toBe(48);
    expect(FIT_CHECKS).toEqual(['none', 'optional', 'required']);
    expect(FIT_ACTION_KINDS).toEqual(['tape', 'stature']);
  });

  it('rejects non-objects', () => {
    for (const bad of [null, 5, 'x', []])
      expect(validateLegModel(bad)).toEqual(['(root): expected an object']);
  });

  it('rejects unknown keys at every level', () => {
    const top = base();
    top.extra = 1;
    expect(has(top, '(root).extra')).toBe(true);
    const ring = base();
    ring.rings[0].extra = 1;
    expect(has(ring, 'rings[0].extra')).toBe(true);
    const act = base();
    act.fit_action.extra = 1;
    expect(has(act, 'fit_action.extra')).toBe(true);
  });

  it('checks header fields', () => {
    for (const [k, v] of [
      ['format', 'x'],
      ['version', 2],
      ['leg', 'B'],
      ['units', 'm'],
      ['frame', 'x'],
      ['estimator_version', '1.0'],
      ['prior_version', 'v1.0.0'],
    ] as const) {
      const m = base();
      m[k] = v;
      expect(has(m, k)).toBe(true);
    }
  });

  it('bounds leg_length_mm by the schema range', () => {
    for (const v of [149.9, 600.1, Number.NaN, '380']) {
      const m = base();
      m.leg_length_mm = v;
      expect(has(m, 'leg_length_mm')).toBe(true);
    }
  });

  it('requires 21 rings of 48 points on the t grid', () => {
    const a = base();
    a.rings.pop();
    expect(has(a, 'rings:')).toBe(true);
    const b = base();
    b.rings[1].points.pop();
    expect(has(b, 'rings[1].points')).toBe(true);
    const c = base();
    c.rings[4].t = 0.2 + 2e-6;
    expect(has(c, 'rings[4].t')).toBe(true);
    const d = base();
    d.rings[4].t = 0.2 + 5e-7;
    expect(validateLegModel(d)).toEqual([]);
  });

  it('rejects clockwise rings and out-of-range coordinates', () => {
    const a = base();
    a.rings[2].points.reverse();
    expect(has(a, 'rings[2].points')).toBe(true);
    const b = base();
    b.rings[2].crest = [301, 0];
    expect(has(b, 'rings[2].crest')).toBe(true);
    const c = base();
    c.rings[2].center = [Number.POSITIVE_INFINITY, 0];
    expect(has(c, 'rings[2].center')).toBe(true);
    const d = base();
    d.rings[2].points[0] = [300, 0];
    expect(validateLegModel(d)).toEqual([]);
  });

  it('ties fit_action to fit_check', () => {
    const a = base();
    a.fit_check = 'none';
    expect(has(a, 'fit_action')).toBe(true);
    const b = base();
    b.fit_action = null;
    expect(has(b, 'fit_action')).toBe(true);
    const c = base();
    c.fit_check = 'none';
    c.fit_action = null;
    expect(validateLegModel(c)).toEqual([]);
    const d = base();
    d.fit_check = 'fail';
    expect(has(d, 'fit_check')).toBe(true);
  });

  it('restricts tape keys to Leg_Length, OW and OD keys', () => {
    for (const key of ['S1_ISW', 'S5_OW', 7, undefined]) {
      const m = base();
      m.fit_action = { kind: 'tape', key };
      expect(has(m, 'fit_action')).toBe(true);
    }
    for (const key of ['Leg_Length', 'S1_OW', 'S4_OD']) {
      const m = base();
      m.fit_action = { kind: 'tape', key };
      expect(validateLegModel(m)).toEqual([]);
    }
    const s = base();
    s.fit_action = { kind: 'stature' };
    expect(validateLegModel(s)).toEqual([]);
    s.fit_action = { kind: 'stature', key: 'S1_OW' };
    expect(has(s, 'fit_action')).toBe(true);
  });
});
