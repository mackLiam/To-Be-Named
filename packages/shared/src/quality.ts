// forms.measurement-quality v1 (docs/ESTIMATOR-V1.md section 2), server and
// admin only. Mirrors services/pipeline/src/forms_pipeline/shape/contract.py;
// change both in the same commit.

import {
  FIT_CHECKS,
  checkExactKeys,
  isFiniteNumber,
  isFitCriticalKey,
  isRecord,
} from './legModel.js';
import type { FitAction, FitCheck } from './legModel.js';
import { validateFitAction } from './legModel.js';
import { MEASUREMENT_KEYS } from './measurements.js';

export const MEASUREMENT_QUALITY_FORMAT = 'forms.measurement-quality';
export const MEASUREMENT_QUALITY_VERSION = 1;

// Per-key provenance; distinct from the measurements.source column (row origin).
export const VALUE_SOURCES = ['observed', 'inferred', 'manual', 'adjusted'] as const;
export type ValueSource = (typeof VALUE_SOURCES)[number];

const SIGMA_MAX_MM = 1000;

export interface MeasurementQuality {
  format: typeof MEASUREMENT_QUALITY_FORMAT;
  version: typeof MEASUREMENT_QUALITY_VERSION;
  values: Record<string, { source: ValueSource; sigma_mm: number }>;
  verdict: FitCheck;
  worst_ratio: number;
  worst_key: string | null;
  tolerances_mm: Record<string, number>;
  action: FitAction | null;
}

const TOP_KEYS = [
  'format',
  'version',
  'values',
  'verdict',
  'worst_ratio',
  'worst_key',
  'tolerances_mm',
  'action',
] as const;

/** Returns violations; an empty array means a valid forms.measurement-quality v1. */
export function validateMeasurementQuality(value: unknown): string[] {
  if (!isRecord(value)) return ['(root): expected an object'];
  const errors = checkExactKeys(value, TOP_KEYS, '(root)');

  if (value['format'] !== MEASUREMENT_QUALITY_FORMAT) {
    errors.push(`format: expected ${MEASUREMENT_QUALITY_FORMAT}`);
  }
  if (value['version'] !== MEASUREMENT_QUALITY_VERSION) {
    errors.push(`version: expected ${MEASUREMENT_QUALITY_VERSION}`);
  }

  const values = value['values'];
  if (!isRecord(values)) {
    errors.push('values: expected an object');
  } else {
    for (const key of Object.keys(values)) {
      if (!(MEASUREMENT_KEYS as readonly string[]).includes(key)) {
        errors.push(`values.${key}: unknown measurement key`);
      }
    }
    for (const key of MEASUREMENT_KEYS) {
      const entry = values[key];
      const path = `values.${key}`;
      if (!(key in values)) {
        errors.push(`${path}: required key is missing`);
      } else if (!isRecord(entry)) {
        errors.push(`${path}: expected an object`);
      } else {
        errors.push(...checkExactKeys(entry, ['source', 'sigma_mm'], path));
        if (!(VALUE_SOURCES as readonly unknown[]).includes(entry['source'])) {
          errors.push(`${path}.source: expected one of ${VALUE_SOURCES.join(', ')}`);
        }
        const s = entry['sigma_mm'];
        if (!isFiniteNumber(s) || s <= 0 || s > SIGMA_MAX_MM) {
          errors.push(`${path}.sigma_mm: expected a finite number in (0, ${SIGMA_MAX_MM}]`);
        }
      }
    }
  }

  const verdict = value['verdict'];
  if (!(FIT_CHECKS as readonly unknown[]).includes(verdict)) {
    errors.push(`verdict: expected one of ${FIT_CHECKS.join(', ')}`);
  }

  const ratio = value['worst_ratio'];
  const ratioOk = isFiniteNumber(ratio) && ratio >= 0;
  if (!ratioOk) errors.push('worst_ratio: expected a finite number >= 0');

  const worstKey = value['worst_key'];
  if ('worst_key' in value && ratioOk) {
    if (ratio === 0) {
      if (worstKey !== null) errors.push('worst_key: must be null when worst_ratio is 0');
    } else if (typeof worstKey !== 'string' || !isFitCriticalKey(worstKey)) {
      errors.push('worst_key: expected a fit-critical key when worst_ratio > 0');
    }
  }

  const tol = value['tolerances_mm'];
  if (!isRecord(tol)) {
    errors.push('tolerances_mm: expected an object');
  } else {
    for (const [key, v] of Object.entries(tol)) {
      if (!(MEASUREMENT_KEYS as readonly string[]).includes(key)) {
        errors.push(`tolerances_mm.${key}: unknown measurement key`);
      }
      if (!isFiniteNumber(v) || v <= 0) {
        errors.push(`tolerances_mm.${key}: expected a finite number > 0`);
      }
    }
  }

  const action = value['action'];
  if ((FIT_CHECKS as readonly unknown[]).includes(verdict) && 'action' in value) {
    if (verdict === 'none') {
      if (action !== null) errors.push('action: must be null when verdict is none');
    } else if (action === null) {
      errors.push('action: required when verdict is not none');
    } else {
      errors.push(...validateFitAction(action, 'action'));
    }
  }
  return errors;
}
