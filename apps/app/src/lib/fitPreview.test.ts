import { MEASUREMENT_KEYS, type Measurements } from '@forms/shared';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEMPLATE,
  GUARD_TEMPLATES,
  computeFitPreview,
  maxHalfExtent,
  profile,
  toSvgPath,
  type FitPreviewGeometry,
  type GuardTemplate,
} from './fitPreview';
import { SLICES, sliceKey } from './library';

const OW = [62, 78, 96, 104];
const OD = [70, 88, 104, 110];

function leg(legLength = 400): Measurements {
  const values = { Leg_Length: legLength } as Measurements;
  SLICES.forEach((s, i) => {
    for (const dim of ['ISW', 'ISD', 'ICW', 'ICD'] as const) values[sliceKey(s, dim)] = 50;
    values[sliceKey(s, 'OW')] = OW[i]!;
    values[sliceKey(s, 'OD')] = OD[i]!;
  });
  return values;
}

function ok(template?: GuardTemplate): FitPreviewGeometry {
  const result = computeFitPreview(leg(), template);
  if (!result.ok) throw new Error('expected geometry');
  return result;
}

const offsetOf = (t: GuardTemplate) => t.clearanceMm + t.linerMm + t.shellMm;

describe('profile', () => {
  it('passes through the slice values at 20/40/60/80 percent', () => {
    const f = profile(OW);
    [0.2, 0.4, 0.6, 0.8].forEach((t, i) => expect(f(t)).toBeCloseTo(OW[i]!, 6));
  });

  it('stays monotone for monotone input and extrapolates gently', () => {
    const f = profile(OW);
    const vals = Array.from({ length: 101 }, (_, i) => f(i / 100));
    vals.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(vals[i]! - 1e-9));
    expect(f(0)).toBeGreaterThanOrEqual(OW[0]! * 0.75);
    expect(f(0)).toBeLessThan(OW[0]!);
    expect(f(1)).toBeLessThanOrEqual(OW[3]! * 1.25);
  });

  it('does not overshoot between slices for a calf bulge', () => {
    const f = profile([60, 100, 100, 80]);
    for (let i = 0; i <= 100; i++) expect(f(i / 100)).toBeLessThanOrEqual(100 + 1e-9);
  });
});

describe('computeFitPreview', () => {
  it('returns closed outlines for both views and summary numbers', () => {
    const g = ok();
    expect(g.templateId).toBe('club');
    expect(g.legLengthMm).toBe(400);
    for (const view of [g.front, g.side]) {
      expect(view.leg.length).toBeGreaterThan(10);
      expect(view.guard.length).toBeGreaterThan(10);
      for (const p of [...view.leg, ...view.guard]) {
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      }
    }
    expect(g.summary.guardHeightMm).toBeCloseTo((0.88 - 0.12) * 400, 6);
    expect(g.summary.guardMaxWidthMm).toBeGreaterThan(0);
  });

  it('runs leg heights monotonically from ankle to knee on the right edge', () => {
    const g = ok();
    const half = g.front.leg.length / 2;
    const right = g.front.leg.slice(0, half);
    expect(right[0]!.y).toBe(0);
    expect(right[half - 1]!.y).toBe(400);
    right.slice(1).forEach((p, i) => expect(p.y).toBeGreaterThan(right[i]!.y));
  });

  it('keeps the guard inside its coverage band', () => {
    for (const t of Object.values(GUARD_TEMPLATES)) {
      const g = ok(t);
      for (const p of [...g.front.guard, ...g.side.guard]) {
        expect(p.y).toBeGreaterThanOrEqual(t.bottom * 400 - 1e-9);
        expect(p.y).toBeLessThanOrEqual(t.top * 400 + 1e-9);
      }
    }
  });

  it('offsets the shell outward by clearance plus liner plus shell', () => {
    const t = DEFAULT_TEMPLATE;
    const g = ok(t);
    const at = (pts: { x: number; y: number }[], y: number) =>
      pts.find((p) => Math.abs(p.y - y) < 1e-6 && p.x > 0)!.x;
    const y = g.front.guard[0]!.y;
    const legHalf = profile(OW)(y / 400) / 2;
    expect(at(g.front.guard, y)).toBeCloseTo(t.wrap * legHalf + offsetOf(t), 6);
    const depthHalf = profile(OD)(y / 400) / 2;
    expect(g.side.guard[0]!.x).toBeCloseTo(depthHalf + offsetOf(t), 6);
    expect(offsetOf(t)).toBe(11);
  });

  it('wraps a front fraction narrower than the leg plus offset', () => {
    const g = ok();
    expect(g.summary.guardMaxWidthMm).toBeLessThan(maxHalfExtent(g.front) * 2 + 1e-9);
    expect(g.summary.guardMaxWidthMm).toBeLessThan(104 + 2 * offsetOf(DEFAULT_TEMPLATE));
  });

  it('rejects missing keys with a typed error', () => {
    const values: Partial<Measurements> = leg();
    delete values[sliceKey('S3', 'OW')];
    delete values.Leg_Length;
    expect(computeFitPreview(values)).toEqual({
      ok: false,
      reason: 'missing',
      keys: ['Leg_Length', sliceKey('S3', 'OW')],
    });
  });

  it('rejects non-finite, non-positive and non-numeric values without throwing', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -4, '12' as unknown as number]) {
      const values = { ...leg(), [sliceKey('S2', 'OD')]: bad };
      expect(computeFitPreview(values)).toEqual({
        ok: false,
        reason: 'invalid',
        keys: [sliceKey('S2', 'OD')],
      });
    }
  });

  it('ignores the inner dimensions it does not draw', () => {
    const values: Partial<Measurements> = leg();
    delete values[sliceKey('S1', 'ISW')];
    expect(computeFitPreview(values).ok).toBe(true);
  });
});

describe('GUARD_TEMPLATES', () => {
  it('holds valid coverage specs keyed by id', () => {
    for (const [id, t] of Object.entries(GUARD_TEMPLATES)) {
      expect(t.id).toBe(id);
      expect(t.bottom).toBeGreaterThanOrEqual(0);
      expect(t.top).toBeLessThanOrEqual(1);
      expect(t.bottom).toBeLessThan(t.top);
      expect(t.wrap).toBeGreaterThan(0);
      expect(t.wrap).toBeLessThan(1);
      expect(offsetOf(t)).toBeGreaterThan(0);
    }
  });

  it('pins Club to its CAD variables and orders the placeholders around it', () => {
    const { club, pro, junior_max } = GUARD_TEMPLATES;
    expect(DEFAULT_TEMPLATE).toBe(club);
    expect(club).toMatchObject({ bottom: 0.12, top: 0.88, wrap: 0.62, placeholder: false });
    expect([club.clearanceMm, club.linerMm, club.shellMm]).toEqual([1, 5, 5]);
    expect(pro.placeholder && junior_max.placeholder).toBe(true);
    const h = (t: GuardTemplate) => t.top - t.bottom;
    expect(h(pro)).toBeLessThan(h(club));
    expect(pro.wrap).toBeLessThan(club.wrap);
    expect(h(junior_max)).toBeGreaterThan(h(club));
    expect(junior_max.wrap).toBeGreaterThan(club.wrap);
  });
});

describe('toSvgPath', () => {
  it('flips y and closes the path', () => {
    expect(
      toSvgPath([
        { x: 1, y: 2 },
        { x: -1, y: 3 },
      ]),
    ).toBe('M1.00 -2.00 L-1.00 -3.00 Z');
  });
});

it('fixture covers every frozen key', () => {
  expect(Object.keys(leg()).sort()).toEqual([...MEASUREMENT_KEYS].sort());
});
