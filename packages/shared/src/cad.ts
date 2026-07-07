// CAD model descriptor: points a product at the CAD model that generates its
// STL and describes how the frozen 25-variable measurement schema maps onto
// that model's own variable names. Stored per product in the nullable
// `public.products.cad_model jsonb` column. This shape is a frozen contract
// shared with the Python pipeline, implemented in parallel - do not diverge.

import { MEASUREMENT_KEYS } from './measurements.js';

// Registry keys for CAD providers. Adding a new provider (e.g. "cadquery")
// is a one-line edit here plus a case in validateRef below.
export const CAD_PROVIDERS = ['onshape', 'dry_run'] as const;

export type CadProvider = (typeof CAD_PROVIDERS)[number];

export interface OnshapeRef {
  document_id: string;
  workspace_id: string;
  element_id: string;
}

// dry_run has no addressing information; it exists so the pipeline can be
// exercised end to end without a real CAD backend.
export type DryRunRef = Record<string, never>;

export type CadModelDescriptor = {
  provider: CadProvider;
  schema_version: string;
  ref: OnshapeRef | DryRunRef | Record<string, unknown>;
  variable_map?: Record<string, string> | null;
};

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Validates a CAD model descriptor. Returns an array of human-readable
 * violations; an empty array means the value is valid. Mirrors the
 * hand-rolled-validator-returning-string[] style used elsewhere in this
 * package (see validate.ts) rather than pulling in Ajv for a shape this small.
 */
export function validateCadModelDescriptor(value: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return ['(root): expected an object'];
  }

  const { provider, schema_version, ref, variable_map } = value as Record<string, unknown>;

  if (!isNonEmptyString(provider) || !(CAD_PROVIDERS as readonly string[]).includes(provider)) {
    errors.push(
      `provider: expected one of ${CAD_PROVIDERS.join(', ')}, got ${JSON.stringify(provider)}`,
    );
  }

  if (!isNonEmptyString(schema_version) || !SEMVER_RE.test(schema_version)) {
    errors.push(`schema_version: expected a semver string, got ${JSON.stringify(schema_version)}`);
  }

  // ref is validated per-provider; only do so when the provider is itself
  // valid, so an unknown provider produces one error, not a confusing second
  // one about a ref shape that does not apply.
  if (isNonEmptyString(provider) && (CAD_PROVIDERS as readonly string[]).includes(provider)) {
    errors.push(...validateRef(provider as CadProvider, ref));
  }

  errors.push(...validateVariableMap(variable_map));

  return errors;
}

function validateRef(provider: CadProvider, ref: unknown): string[] {
  const errors: string[] = [];

  if (ref !== undefined && !isRecord(ref)) {
    errors.push(`ref: expected an object, got ${JSON.stringify(ref)}`);
    return errors;
  }

  const refObj = ref ?? {};

  switch (provider) {
    case 'onshape': {
      for (const key of ['document_id', 'workspace_id', 'element_id'] as const) {
        const fieldValue = (refObj as Record<string, unknown>)[key];
        if (!isNonEmptyString(fieldValue)) {
          errors.push(
            `ref.${key}: required non-empty string for provider "onshape", got ${JSON.stringify(fieldValue)}`,
          );
        }
      }
      break;
    }
    case 'dry_run':
      // No fields required; an empty object or an omitted ref are both fine.
      break;
  }

  return errors;
}

function validateVariableMap(variableMap: unknown): string[] {
  const errors: string[] = [];

  if (variableMap === null || variableMap === undefined) {
    return errors;
  }

  if (!isRecord(variableMap)) {
    return [
      `variable_map: expected an object, null, or omitted, got ${JSON.stringify(variableMap)}`,
    ];
  }

  const knownKeys = new Set<string>(MEASUREMENT_KEYS);

  for (const [key, mapped] of Object.entries(variableMap)) {
    if (!knownKeys.has(key)) {
      errors.push(`variable_map.${key}: not one of the 25 measurement variable names`);
    }
    if (!isNonEmptyString(mapped)) {
      errors.push(
        `variable_map.${key}: expected a non-empty string, got ${JSON.stringify(mapped)}`,
      );
    }
  }

  return errors;
}

/**
 * Renames measurement keys per variable_map, leaving unmapped keys as-is
 * (identity for unmapped names). Passing null or undefined for map is
 * equivalent to an empty map: values is returned with identity renaming
 * (i.e. a shallow copy of values).
 */
export function applyVariableMap(
  values: Record<string, number>,
  map: Record<string, string> | null | undefined,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(values)) {
    const mappedKey = map?.[key] ?? key;
    result[mappedKey] = value;
  }
  return result;
}
