// forms.leg-model v1 (docs/ESTIMATOR-V1.md section 1). Mirrors
// services/pipeline/src/forms_pipeline/shape/contract.py; change both in the
// same commit.

import { LEG_LENGTH_RANGE_MM, MEASUREMENT_KEYS } from './measurements.js';

export const LEG_MODEL_FORMAT = 'forms.leg-model';
export const LEG_MODEL_VERSION = 1;
export const LEG_MODEL_FRAME = 'x_right_y_anterior_z_up';
export const LEG_MODEL_RING_COUNT = 21;
export const LEG_MODEL_RING_POINTS = 48;

export const FIT_CHECKS = ['none', 'optional', 'required'] as const;
export type FitCheck = (typeof FIT_CHECKS)[number];

export const FIT_ACTION_KINDS = ['tape', 'stature'] as const;

export type FitAction = { kind: 'tape'; key: string } | { kind: 'stature' };

export interface LegModelRing {
  t: number;
  center: [number, number];
  crest: [number, number];
  points: [number, number][];
}

export interface LegModel {
  format: typeof LEG_MODEL_FORMAT;
  version: typeof LEG_MODEL_VERSION;
  leg: 'L' | 'R';
  units: 'mm';
  frame: typeof LEG_MODEL_FRAME;
  estimator_version: string;
  prior_version: string;
  leg_length_mm: number;
  rings: LegModelRing[];
  fit_check: FitCheck;
  fit_action: FitAction | null;
}

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const T_TOLERANCE = 1e-6;
const COORD_LIMIT_MM = 300;

const TOP_KEYS = [
  'format',
  'version',
  'leg',
  'units',
  'frame',
  'estimator_version',
  'prior_version',
  'leg_length_mm',
  'rings',
  'fit_check',
  'fit_action',
] as const;
const RING_KEYS = ['t', 'center', 'crest', 'points'] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function checkExactKeys(
  obj: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) errors.push(`${path}.${key}: unknown key`);
  }
  for (const key of keys) {
    if (!(key in obj)) errors.push(`${path}.${key}: required key is missing`);
  }
  return errors;
}

function legLengthBounds(): { min: number; max: number } {
  return LEG_LENGTH_RANGE_MM;
}

// The leg-length key or any OW/OD key; derived from the schema names.
export function isFitCriticalKey(key: string): boolean {
  return (
    (MEASUREMENT_KEYS as readonly string[]).includes(key) &&
    (key === 'Leg_Length' || key.endsWith('_OW') || key.endsWith('_OD'))
  );
}

// Shared by the leg-model and measurement-quality validators. Returns
// violations for a fit_action / action value that must be non-null.
export function validateFitAction(value: unknown, path: string): string[] {
  if (!isRecord(value)) return [`${path}: expected an object`];
  const kind = value['kind'];
  if (kind === 'stature') return checkExactKeys(value, ['kind'], path);
  if (kind === 'tape') {
    const errors = checkExactKeys(value, ['kind', 'key'], path);
    const key = value['key'];
    if (typeof key !== 'string' || !isFitCriticalKey(key)) {
      errors.push(`${path}.key: expected a fit-critical measurement key`);
    }
    return errors;
  }
  return [`${path}.kind: expected one of ${FIT_ACTION_KINDS.join(', ')}`];
}

function validateXY(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length !== 2) return [`${path}: expected [x, y]`];
  const errors: string[] = [];
  value.forEach((c: unknown, i) => {
    if (!isFiniteNumber(c)) errors.push(`${path}[${i}]: expected a finite number`);
    else if (Math.abs(c) > COORD_LIMIT_MM) {
      errors.push(`${path}[${i}]: magnitude exceeds ${COORD_LIMIT_MM} mm`);
    }
  });
  return errors;
}

function signedArea(points: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as [number, number];
    const b = points[(i + 1) % points.length] as [number, number];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

function validateRing(ring: unknown, k: number): string[] {
  const path = `rings[${k}]`;
  if (!isRecord(ring)) return [`${path}: expected an object`];
  const errors = checkExactKeys(ring, RING_KEYS, path);

  const t = ring['t'];
  if (!isFiniteNumber(t) || Math.abs(t - k / (LEG_MODEL_RING_COUNT - 1)) > T_TOLERANCE) {
    errors.push(`${path}.t: expected k/${LEG_MODEL_RING_COUNT - 1} within ${T_TOLERANCE}`);
  }
  if ('center' in ring) errors.push(...validateXY(ring['center'], `${path}.center`));
  if ('crest' in ring) errors.push(...validateXY(ring['crest'], `${path}.crest`));

  if ('points' in ring) {
    const points = ring['points'];
    if (!Array.isArray(points) || points.length !== LEG_MODEL_RING_POINTS) {
      errors.push(`${path}.points: expected exactly ${LEG_MODEL_RING_POINTS} points`);
    } else {
      const before = errors.length;
      points.forEach((p: unknown, i) => errors.push(...validateXY(p, `${path}.points[${i}]`)));
      if (errors.length === before && signedArea(points as [number, number][]) <= 0) {
        errors.push(`${path}.points: ring must be counter-clockwise seen from +z`);
      }
    }
  }
  return errors;
}

/** Returns violations; an empty array means a valid forms.leg-model v1. */
export function validateLegModel(value: unknown): string[] {
  if (!isRecord(value)) return ['(root): expected an object'];
  const errors = checkExactKeys(value, TOP_KEYS, '(root)');

  if (value['format'] !== LEG_MODEL_FORMAT) errors.push(`format: expected ${LEG_MODEL_FORMAT}`);
  if (value['version'] !== LEG_MODEL_VERSION) errors.push(`version: expected ${LEG_MODEL_VERSION}`);
  if (value['leg'] !== 'L' && value['leg'] !== 'R') errors.push('leg: expected L or R');
  if (value['units'] !== 'mm') errors.push('units: expected mm');
  if (value['frame'] !== LEG_MODEL_FRAME) errors.push(`frame: expected ${LEG_MODEL_FRAME}`);
  for (const key of ['estimator_version', 'prior_version']) {
    const v = value[key];
    if (typeof v !== 'string' || !SEMVER_RE.test(v))
      errors.push(`${key}: expected a semver string`);
  }

  const { min, max } = legLengthBounds();
  const len = value['leg_length_mm'];
  if (!isFiniteNumber(len) || len < min || len > max) {
    errors.push(`leg_length_mm: expected a finite number within ${min}-${max}`);
  }

  const rings = value['rings'];
  if (!Array.isArray(rings) || rings.length !== LEG_MODEL_RING_COUNT) {
    errors.push(`rings: expected exactly ${LEG_MODEL_RING_COUNT} rings`);
  } else {
    rings.forEach((r: unknown, k) => errors.push(...validateRing(r, k)));
  }

  const fitCheck = value['fit_check'];
  const action = value['fit_action'];
  if (!(FIT_CHECKS as readonly unknown[]).includes(fitCheck)) {
    errors.push(`fit_check: expected one of ${FIT_CHECKS.join(', ')}`);
  } else if ('fit_action' in value) {
    if (fitCheck === 'none') {
      if (action !== null) errors.push('fit_action: must be null when fit_check is none');
    } else if (action === null) {
      errors.push('fit_action: required when fit_check is not none');
    } else {
      errors.push(...validateFitAction(action, 'fit_action'));
    }
  }
  return errors;
}
