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

// Where an Onshape model keeps its variables: Part Studio Variable features in
// a template copied per job (the default when omitted), or a Variable Studio.
export const CAD_VARIABLE_KINDS = ['variable_studio', 'part_studio_features'] as const;

export type CadVariableKind = (typeof CAD_VARIABLE_KINDS)[number];

// The stored 25 values are leg measurements; the CAD model's same-named
// variables are crest-relative points on the guard's inner curve. The pipeline
// converts once, in services/pipeline/src/forms_pipeline/cad/profile.py; this
// file only validates the descriptor.
export const CAD_PROFILE_KINDS = ['identity', 'crest_spline_v1'] as const;

export type CadProfileKind = (typeof CAD_PROFILE_KINDS)[number];

export interface CadWrap {
  inner_shin: number;
  inner_calf: number;
  outer: number;
}

export type CadProfile = { kind: 'identity' } | { kind: 'crest_spline_v1'; wrap: CadWrap };

export type CadModelDescriptor = {
  provider: CadProvider;
  profile: CadProfile;
  schema_version: string;
  ref: OnshapeRef | DryRunRef | Record<string, unknown>;
  variable_map?: Record<string, string> | null;
  variable_kind?: CadVariableKind;
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

  const { provider, schema_version, ref, variable_map, variable_kind, profile } = value as Record<
    string,
    unknown
  >;

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
  errors.push(...validateProfile(profile));

  if (
    variable_kind !== undefined &&
    !(CAD_VARIABLE_KINDS as readonly unknown[]).includes(variable_kind)
  ) {
    errors.push(
      `variable_kind: expected one of ${CAD_VARIABLE_KINDS.join(', ')} or omitted, got ${JSON.stringify(variable_kind)}`,
    );
  }

  return errors;
}

function validateProfile(profile: unknown): string[] {
  if (!isRecord(profile)) {
    return [`profile: required object, got ${JSON.stringify(profile)}`];
  }

  const errors: string[] = [];
  for (const key of Object.keys(profile)) {
    if (key !== 'kind' && key !== 'wrap') {
      errors.push(`profile.${key}: unknown key`);
    }
  }

  const { kind, wrap } = profile;
  if (!(CAD_PROFILE_KINDS as readonly unknown[]).includes(kind)) {
    errors.push(
      `profile.kind: expected one of ${CAD_PROFILE_KINDS.join(', ')}, got ${JSON.stringify(kind)}`,
    );
    return errors;
  }

  if (kind === 'identity') {
    if ('wrap' in profile) {
      errors.push('profile.wrap: not allowed for kind "identity"');
    }
    return errors;
  }

  if (!isRecord(wrap)) {
    errors.push(
      `profile.wrap: required object for kind "crest_spline_v1", got ${JSON.stringify(wrap)}`,
    );
    return errors;
  }

  const wrapKeys = ['inner_shin', 'inner_calf', 'outer'] as const;
  for (const key of Object.keys(wrap)) {
    if (!(wrapKeys as readonly string[]).includes(key)) {
      errors.push(`profile.wrap.${key}: unknown key`);
    }
  }
  let allFinite = true;
  for (const key of wrapKeys) {
    const v = wrap[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      allFinite = false;
      errors.push(`profile.wrap.${key}: required finite number, got ${JSON.stringify(v)}`);
    }
  }
  if (!allFinite) return errors;

  const { inner_shin, inner_calf, outer } = wrap as unknown as CadWrap;
  if (!(inner_shin > 0)) {
    errors.push(`profile.wrap.inner_shin: must be greater than 0, got ${inner_shin}`);
  }
  if (!(inner_shin < inner_calf)) {
    errors.push(
      `profile.wrap.inner_calf: must be greater than inner_shin (${inner_shin}), got ${inner_calf}`,
    );
  }
  if (!(inner_calf < 1)) {
    errors.push(`profile.wrap.inner_calf: must be less than 1, got ${inner_calf}`);
  }
  if (!(outer > 0 && outer < 1)) {
    errors.push(`profile.wrap.outer: must be between 0 and 1 exclusive, got ${outer}`);
  }
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
