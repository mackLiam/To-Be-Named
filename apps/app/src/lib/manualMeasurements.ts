/**
 * Manual measurement logic: the fallback when a scan fails or is skipped, and
 * the "check after" adjust mode over a scan's values. Pure, tested in
 * manualMeasurements.test.ts.
 *
 * A person with a tape and two flat books can measure 9 of the 25 schema
 * values: Leg_Length plus OW and OD at S1..S4. The other 16 are derived per
 * the extraction's definitions (services/pipeline extraction/measure.py):
 * the section is split at its centroid into a medial and a lateral half,
 * ISW/ICW are the halves' X extents (ISW + ICW == OW), ISD/ICD the Y extents
 * within each half. With no scan to go on, the estimate is a symmetric
 * section: ISW = ICW = OW / 2 and ISD = ICD = OD.
 *
 * Ranges come from the shared JSON Schema file (the one the server and the
 * pipeline validate against). The shared validateMeasurements reads that
 * file with node:fs, which cannot run in the app bundle, so this module reads
 * the same file through the package export instead; the test asserts both
 * agree.
 */

import type { MeasurementKey, Measurements } from '@forms/shared';
import schemaJson from '@forms/shared/schema/measurements.schema.json';

import { SLICES, SLICE_DIMS, sliceKey } from './library';

export type Slice = (typeof SLICES)[number];
export type SliceDim = (typeof SLICE_DIMS)[number];
export type Values = Partial<Record<MeasurementKey, number>>;

interface SchemaShape {
  required: MeasurementKey[];
  properties: Record<MeasurementKey, { minimum: number; maximum: number }>;
}
const schema = schemaJson as unknown as SchemaShape;

/** All 25 keys in contract order, from the schema file itself. */
export const ALL_KEYS: readonly MeasurementKey[] = schema.required;

/** Fractions of Leg_Length, measured up from the bottom of the ankle (frozen contract). */
export const SLICE_FRACTIONS: Record<Slice, number> = { S1: 0.2, S2: 0.4, S3: 0.6, S4: 0.8 };

export const LEG_LENGTH: MeasurementKey = 'Leg_Length';

/** The 9 tape-measurable fields, in the order the guided flow asks for them. */
export const MANUAL_KEYS: readonly MeasurementKey[] = [
  LEG_LENGTH,
  ...SLICES.flatMap((slice) => [sliceKey(slice, 'OW'), sliceKey(slice, 'OD')]),
];

/** The 16 values derived from the manual ones. */
export const DERIVED_KEYS: readonly MeasurementKey[] = ALL_KEYS.filter(
  (key) => !MANUAL_KEYS.includes(key),
);

/** A change over this percent against the scan gets a "double check" flag. */
export const BIG_CHANGE_PERCENT = 15;

const DIM_LABELS: Record<SliceDim, string> = {
  OW: 'Width',
  OD: 'Depth',
  ISW: 'Inner shin width',
  ISD: 'Inner shin depth',
  ICW: 'Inner calf width',
  ICD: 'Inner calf depth',
};

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Which slice and dimension a key is, or null for Leg_Length. */
export function parseKey(key: MeasurementKey): { slice: Slice; dim: SliceDim } | null {
  const [slice, dim] = key.split('_') as [Slice, SliceDim];
  return SLICES.includes(slice) ? { slice, dim } : null;
}

/** 1-based mark number on the leg: mark 1 is S1, nearest the ankle. */
export function markNumber(slice: Slice): number {
  return SLICES.indexOf(slice) + 1;
}

/** "Leg length", "Width at mark 2", "Inner calf depth at mark 4". */
export function fieldLabel(key: MeasurementKey): string {
  const parsed = parseKey(key);
  return parsed ? `${DIM_LABELS[parsed.dim]} at mark ${markNumber(parsed.slice)}` : 'Leg length';
}

/** Heights of the four marks above the ankle point, mm to one decimal. */
export function sliceHeights(legLength: number): Record<Slice, number> {
  return Object.fromEntries(
    SLICES.map((slice) => [slice, round1(legLength * SLICE_FRACTIONS[slice])]),
  ) as Record<Slice, number>;
}

/** "78.4 mm", or "78 mm" for a whole number. */
export function formatMmShort(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)} mm`;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Keep what a mm field may hold while typing: up to 3 digits, one decimal
 * separator (comma accepted, many locales' decimal pads show one), one decimal. */
export function sanitizeMmInput(text: string): string {
  const match = /^(\d{0,3})(?:[.,](\d?))?/.exec(text.replace(/[^\d.,]/g, ''));
  if (!match) return '';
  const [, whole = '', decimal] = match;
  return decimal === undefined ? whole : `${whole}.${decimal}`;
}

/** Parse a field's text to mm; null for empty or not a number. */
export function parseMm(text: string | undefined): number | null {
  if (!text || !/^\d+(?:[.,]\d)?$/.test(text.trim())) return null;
  return Number(text.trim().replace(',', '.'));
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export interface Derived {
  values: Values;
  /** Derived keys whose value is an estimate (not measured, not from the scan, not typed in). */
  estimated: MeasurementKey[];
}

/**
 * Fill the 16 derived values from the measured OW/OD.
 * - overrides (Advanced edit) win as typed.
 * - With a scan base, the scan's halves are scaled by the new OW/OD, keeping
 *   the scan's medial/lateral split; an unchanged OW/OD keeps the scan values.
 * - Without one, the symmetric estimate: halves of OW, and OD for both depths.
 */
export function deriveMeasurements(
  entered: Values,
  options: { base?: Measurements; overrides?: Values } = {},
): Derived {
  const { base, overrides = {} } = options;
  const values: Values = {};
  const estimated: MeasurementKey[] = [];
  for (const key of MANUAL_KEYS) {
    if (entered[key] !== undefined) values[key] = entered[key];
  }

  for (const slice of SLICES) {
    const pairs = [
      { full: 'OW', halves: ['ISW', 'ICW'], split: true },
      { full: 'OD', halves: ['ISD', 'ICD'], split: false },
    ] as const;
    for (const { full, halves, split } of pairs) {
      const measured = entered[sliceKey(slice, full)];
      const keys = halves.map((dim) => sliceKey(slice, dim));
      const scanFull = base?.[sliceKey(slice, full)];
      const computed: (number | undefined)[] = keys.map(() => undefined);
      let isEstimate = true;
      if (measured !== undefined) {
        if (base && scanFull) {
          const ratio = measured / scanFull;
          isEstimate = ratio !== 1;
          keys.forEach((key, i) => {
            computed[i] = isEstimate ? round1(base[key] * ratio) : base[key];
          });
          // Keep ISW + ICW == OW exactly after rounding.
          if (split && isEstimate) computed[1] = round1(measured - (computed[0] as number));
        } else if (split) {
          computed[0] = round1(measured / 2);
          computed[1] = round1(measured - computed[0]);
        } else {
          computed[0] = measured;
          computed[1] = measured;
        }
      }
      keys.forEach((key, i) => {
        const override = overrides[key];
        if (override !== undefined) {
          values[key] = override;
        } else if (computed[i] !== undefined) {
          values[key] = computed[i];
          if (isEstimate) estimated.push(key);
        }
      });
    }
  }
  return { values, estimated: DERIVED_KEYS.filter((key) => estimated.includes(key)) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function range(key: MeasurementKey): { min: number; max: number } {
  const prop = schema.properties[key];
  return { min: prop.minimum, max: prop.maximum };
}

/** Plain-language problem with one value, or null when it is in range. */
export function checkField(key: MeasurementKey, value: number | null | undefined): string | null {
  const label = fieldLabel(key);
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return `Enter the ${label.toLowerCase()} in millimetres.`;
  }
  const { min, max } = range(key);
  if (value >= min && value <= max) return null;
  const between = `It should be between ${min} and ${max} mm.`;
  if (value < min) {
    const cmHint = value * 10 >= min && value * 10 <= max ? ' Check it is in mm, not cm.' : '';
    return `${label} looks too small. ${between}${cmHint} Measure again.`;
  }
  return `${label} looks too large. ${between} Measure again.`;
}

export type ManualValidation =
  | { ok: true; measurements: Measurements }
  | { ok: false; errors: Partial<Record<MeasurementKey, string>> };

/** Check all 25 against the schema ranges and build the exact 25-key object. */
export function validateManual(values: Values): ManualValidation {
  const errors: Partial<Record<MeasurementKey, string>> = {};
  const measurements = {} as Measurements;
  for (const key of ALL_KEYS) {
    const problem = checkField(key, values[key]);
    if (problem) errors[key] = problem;
    else measurements[key] = values[key] as number;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, measurements };
}

// ---------------------------------------------------------------------------
// Diff against the scan (adjust mode)
// ---------------------------------------------------------------------------

export interface FieldDiff {
  key: MeasurementKey;
  scanned: number;
  entered: number;
  /** entered - scanned, mm, one decimal. */
  delta: number;
  /** delta as a percent of scanned, one decimal. */
  percent: number;
  /** Over BIG_CHANGE_PERCENT either way: "big change, double check". */
  big: boolean;
}

/** Per-field change for every key with a value on both sides, contract order. */
export function diffAgainstScan(scan: Measurements, entered: Values): FieldDiff[] {
  return ALL_KEYS.flatMap((key) => {
    const value = entered[key];
    const scanned = scan[key];
    if (value === undefined || !scanned) return [];
    const percent = round1(((value - scanned) / scanned) * 100);
    return [
      {
        key,
        scanned,
        entered: value,
        delta: round1(value - scanned),
        percent,
        big: Math.abs(percent) > BIG_CHANGE_PERCENT,
      },
    ];
  });
}

/** "+3.0 mm (+4.8%)". */
export function formatDiff(diff: FieldDiff): string {
  const sign = (n: number) => (n > 0 ? '+' : n < 0 ? '-' : '');
  return `${sign(diff.delta)}${Math.abs(diff.delta).toFixed(1)} mm (${sign(diff.percent)}${Math.abs(diff.percent).toFixed(1)}%)`;
}
