import type { MeasurementKey, Measurements } from '@forms/shared';

import { SLICES, sliceKey } from './library';

/**
 * Pre-purchase fit preview, drawn from the 25 measurements alone. It never
 * touches Onshape (documents are created only on purchase), so it is an
 * approximation: the made guard comes from the CAD model, not from this.
 *
 * Coordinates are mm. y is height up from the bottom of the ankle (0) to the
 * knee (Leg_Length). x is 0 on the leg's centre line; +x is the front (shin)
 * in the side view. The cross-section is modelled as an ellipse with axes
 * OW and OD at each height.
 */

export interface GuardTemplate {
  id: string;
  name: string;
  /** Coverage band as fractions of Leg_Length, measured up from the ankle. */
  bottom: number;
  top: number;
  /** Fraction of the leg's front width the shell covers, 0 < wrap < 1. */
  wrap: number;
  /** CAD Fit_Clearance. */
  clearanceMm: number;
  /** CAD EVA_Thickness. */
  linerMm: number;
  /** CAD Shell_Thickness. */
  shellMm: number;
  /** True when the coverage numbers are illustrative, not from a CAD model. */
  placeholder: boolean;
}

export const GUARD_TEMPLATES = {
  club: {
    id: 'club',
    name: 'Club',
    bottom: 0.12,
    top: 0.88,
    wrap: 0.62,
    clearanceMm: 1,
    linerMm: 5,
    shellMm: 5,
    placeholder: false,
  },
  // Placeholder: no CAD model yet. Shorter and narrower than Club.
  pro: {
    id: 'pro',
    name: 'Pro',
    bottom: 0.2,
    top: 0.82,
    wrap: 0.54,
    clearanceMm: 1,
    linerMm: 4,
    shellMm: 4,
    placeholder: true,
  },
  // Placeholder: no CAD model yet. Taller and wider than Club.
  junior_max: {
    id: 'junior_max',
    name: 'Junior Max',
    bottom: 0.08,
    top: 0.92,
    wrap: 0.7,
    clearanceMm: 1,
    linerMm: 6,
    shellMm: 5,
    placeholder: true,
  },
} as const satisfies Record<string, GuardTemplate>;

export type GuardTemplateId = keyof typeof GUARD_TEMPLATES;

export const DEFAULT_TEMPLATE: GuardTemplate = GUARD_TEMPLATES.club;

export interface Point {
  x: number;
  y: number;
}

/** Closed polygons in mm. */
export interface ViewOutline {
  leg: Point[];
  guard: Point[];
}

export interface FitPreviewGeometry {
  ok: true;
  templateId: string;
  legLengthMm: number;
  front: ViewOutline;
  side: ViewOutline;
  summary: {
    guardHeightMm: number;
    guardMaxWidthMm: number;
  };
}

export interface FitPreviewError {
  ok: false;
  reason: 'missing' | 'invalid';
  keys: MeasurementKey[];
}

export type FitPreviewResult = FitPreviewGeometry | FitPreviewError;

const SLICE_FRACTIONS = [0.2, 0.4, 0.6, 0.8] as const;
const LEG_SAMPLES = 41;
const GUARD_SAMPLES = 25;
// Ankle and knee values are extrapolated from the end slope at half strength
// and held within 25% of the nearest slice, so a noisy end slice cannot
// produce a spike or a pinch the scan never saw.
const EXTRAPOLATION_DAMPING = 0.5;
const EXTRAPOLATION_LIMIT = 0.25;

function readMeasurements(
  measurements: Partial<Measurements>,
): { legLength: number; ow: number[]; od: number[] } | FitPreviewError {
  const needed: MeasurementKey[] = [
    'Leg_Length',
    ...SLICES.map((s) => sliceKey(s, 'OW')),
    ...SLICES.map((s) => sliceKey(s, 'OD')),
  ];
  const missing = needed.filter((k) => measurements[k] === undefined || measurements[k] === null);
  if (missing.length > 0) return { ok: false, reason: 'missing', keys: missing };
  const invalid = needed.filter((k) => {
    const v = measurements[k];
    return typeof v !== 'number' || !Number.isFinite(v) || v <= 0;
  });
  if (invalid.length > 0) return { ok: false, reason: 'invalid', keys: invalid };
  const value = (k: MeasurementKey) => measurements[k] as number;
  return {
    legLength: value('Leg_Length'),
    ow: SLICES.map((s) => value(sliceKey(s, 'OW'))),
    od: SLICES.map((s) => value(sliceKey(s, 'OD'))),
  };
}

function extrapolate(edge: number, inner: number): number {
  const raw = edge + EXTRAPOLATION_DAMPING * (edge - inner);
  const lo = edge * (1 - EXTRAPOLATION_LIMIT);
  const hi = edge * (1 + EXTRAPOLATION_LIMIT);
  return Math.min(hi, Math.max(lo, raw));
}

/**
 * Fritsch-Carlson monotone cubic through the four slice values plus the
 * extrapolated ankle (t=0) and knee (t=1) values. Monotone cubic, not
 * Catmull-Rom, so the curve never overshoots between slices.
 */
export function profile(sliceValues: readonly number[]): (t: number) => number {
  const [v1, v2, v3, v4] = sliceValues as [number, number, number, number];
  const ts = [0, ...SLICE_FRACTIONS, 1];
  const vs = [extrapolate(v1, v2), v1, v2, v3, v4, extrapolate(v4, v3)];
  const n = vs.length;
  const delta = Array.from(
    { length: n - 1 },
    (_, k) => (vs[k + 1]! - vs[k]!) / (ts[k + 1]! - ts[k]!),
  );
  const m = vs.map((_, k) => {
    if (k === 0) return delta[0]!;
    if (k === n - 1) return delta[n - 2]!;
    const a = delta[k - 1]!;
    const b = delta[k]!;
    return a * b <= 0 ? 0 : (a + b) / 2;
  });
  for (let k = 0; k < n - 1; k++) {
    const d = delta[k]!;
    if (d === 0) {
      m[k] = 0;
      m[k + 1] = 0;
      continue;
    }
    const a = m[k]! / d;
    const b = m[k + 1]! / d;
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[k] = tau * a * d;
      m[k + 1] = tau * b * d;
    }
  }
  return (t: number) => {
    const tc = Math.min(1, Math.max(0, t));
    let k = 0;
    while (k < n - 2 && tc > ts[k + 1]!) k++;
    const h = ts[k + 1]! - ts[k]!;
    const u = (tc - ts[k]!) / h;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
    const h10 = u ** 3 - 2 * u ** 2 + u;
    const h01 = -2 * u ** 3 + 3 * u ** 2;
    const h11 = u ** 3 - u ** 2;
    return h00 * vs[k]! + h10 * h * m[k]! + h01 * vs[k + 1]! + h11 * h * m[k + 1]!;
  };
}

function samples(from: number, to: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
}

/** Right edge bottom to top, then the mirrored left edge top to bottom. */
function mirrored(edge: Point[]): Point[] {
  return [...edge, ...[...edge].reverse().map((p) => ({ x: -p.x, y: p.y }))];
}

export function computeFitPreview(
  measurements: Partial<Measurements>,
  template: GuardTemplate = DEFAULT_TEMPLATE,
): FitPreviewResult {
  const read = readMeasurements(measurements);
  if ('ok' in read) return read;
  const { legLength, ow, od } = read;
  const width = profile(ow);
  const depth = profile(od);
  const offset = template.clearanceMm + template.linerMm + template.shellMm;
  // Ellipse model: covering the middle `wrap` of the width reaches back from
  // the front surface by (1 - sqrt(1 - wrap^2)) of the half depth.
  const reach = 1 - Math.sqrt(1 - template.wrap ** 2);

  const legT = samples(0, 1, LEG_SAMPLES);
  const guardT = samples(template.bottom, template.top, GUARD_SAMPLES);

  const front: ViewOutline = {
    leg: mirrored(legT.map((t) => ({ x: width(t) / 2, y: t * legLength }))),
    guard: mirrored(
      guardT.map((t) => ({ x: (template.wrap * width(t)) / 2 + offset, y: t * legLength })),
    ),
  };
  const side: ViewOutline = {
    leg: mirrored(legT.map((t) => ({ x: depth(t) / 2, y: t * legLength }))),
    guard: [
      ...guardT.map((t) => ({ x: depth(t) / 2 + offset, y: t * legLength })),
      ...[...guardT].reverse().map((t) => ({ x: (depth(t) / 2) * (1 - reach), y: t * legLength })),
    ],
  };

  return {
    ok: true,
    templateId: template.id,
    legLengthMm: legLength,
    front,
    side,
    summary: {
      guardHeightMm: (template.top - template.bottom) * legLength,
      guardMaxWidthMm: Math.max(...front.guard.map((p) => 2 * p.x)),
    },
  };
}

/** SVG path for a closed polygon, flipping y so the knee is at the top. */
export function toSvgPath(points: readonly Point[]): string {
  return (
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${(-p.y).toFixed(2)}`).join(' ') +
    ' Z'
  );
}

/** Half-extent in x of every polygon in a view, for a shared drawing scale. */
export function maxHalfExtent(view: ViewOutline): number {
  return Math.max(...view.leg.map((p) => Math.abs(p.x)), ...view.guard.map((p) => Math.abs(p.x)));
}
