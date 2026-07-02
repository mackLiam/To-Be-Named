import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import type { Measurements } from './measurements.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

// The canonical, cross-language source of truth is the JSON file on disk
// (also consumed by the Python pipeline). Reading it at module init, rather
// than duplicating its contents in TypeScript, is what keeps them from
// drifting apart.
const schemaPath = join(moduleDir, '..', 'schema', 'measurements.schema.json');
const schemaText = readFileSync(schemaPath, 'utf-8');

export const measurementsSchema = JSON.parse(schemaText) as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, verbose: true, strict: false });
const validateFn = ajv.compile(measurementsSchema);

export type ValidationResult =
  { valid: true; measurements: Measurements } | { valid: false; errors: string[] };

export function validateMeasurements(data: unknown): ValidationResult {
  const valid = validateFn(data);
  if (valid) {
    return { valid: true, measurements: data as Measurements };
  }
  return { valid: false, errors: (validateFn.errors ?? []).map(formatError) };
}

function formatError(err: ErrorObject): string {
  const key = err.instancePath ? err.instancePath.replace(/^\//, '') : '(root)';

  switch (err.keyword) {
    case 'required': {
      const missing = String((err.params as { missingProperty: string }).missingProperty);
      return `${missing}: required property is missing`;
    }
    case 'additionalProperties': {
      const extra = String((err.params as { additionalProperty: string }).additionalProperty);
      return `${extra}: unexpected property, not part of the measurement schema`;
    }
    case 'minimum':
    case 'maximum': {
      const limit = (err.params as { limit: number }).limit;
      const comparison = err.keyword === 'minimum' ? 'at least' : 'at most';
      return `${key}: expected ${comparison} ${limit}, got ${JSON.stringify(err.data)}`;
    }
    case 'type': {
      const expected = (err.params as { type: string }).type;
      return `${key}: expected type ${expected}, got ${JSON.stringify(err.data)}`;
    }
    default:
      return `${key}: ${err.message ?? 'invalid value'}`;
  }
}
