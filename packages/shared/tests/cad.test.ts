import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../src/measurements.js';
import { applyVariableMap, validateCadModelDescriptor } from '../src/cad.js';

function validOnshapeDescriptor() {
  return {
    provider: 'onshape' as const,
    schema_version: SCHEMA_VERSION,
    ref: {
      document_id: 'doc-1',
      workspace_id: 'ws-1',
      element_id: 'elem-1',
    },
    variable_map: null,
  };
}

function validDryRunDescriptor() {
  return {
    provider: 'dry_run' as const,
    schema_version: SCHEMA_VERSION,
    ref: {},
  };
}

describe('validateCadModelDescriptor', () => {
  it('accepts a valid onshape descriptor', () => {
    expect(validateCadModelDescriptor(validOnshapeDescriptor())).toEqual([]);
  });

  it('accepts a valid dry_run descriptor with an empty ref', () => {
    expect(validateCadModelDescriptor(validDryRunDescriptor())).toEqual([]);
  });

  it('accepts a valid dry_run descriptor with ref omitted entirely', () => {
    const descriptor = validDryRunDescriptor() as Record<string, unknown>;
    delete descriptor.ref;
    expect(validateCadModelDescriptor(descriptor)).toEqual([]);
  });

  it('rejects a non-object value', () => {
    expect(validateCadModelDescriptor('not-an-object')).toEqual(['(root): expected an object']);
    expect(validateCadModelDescriptor(null)).toEqual(['(root): expected an object']);
  });

  it('rejects an unknown provider', () => {
    const descriptor = { ...validOnshapeDescriptor(), provider: 'cadquery' };
    const errors = validateCadModelDescriptor(descriptor);
    expect(errors.some((e) => e.startsWith('provider:'))).toBe(true);
  });

  it('rejects a missing onshape ref id', () => {
    const descriptor = validOnshapeDescriptor();
    delete (descriptor.ref as Record<string, unknown>).workspace_id;
    const errors = validateCadModelDescriptor(descriptor);
    expect(errors.some((e) => e.includes('ref.workspace_id'))).toBe(true);
  });

  it('rejects an empty-string onshape ref id', () => {
    const descriptor = validOnshapeDescriptor();
    descriptor.ref.element_id = '';
    const errors = validateCadModelDescriptor(descriptor);
    expect(errors.some((e) => e.includes('ref.element_id'))).toBe(true);
  });

  it('rejects an onshape descriptor with no ref at all', () => {
    const descriptor = validOnshapeDescriptor() as Record<string, unknown>;
    delete descriptor.ref;
    const errors = validateCadModelDescriptor(descriptor);
    expect(errors.some((e) => e.includes('ref.document_id'))).toBe(true);
    expect(errors.some((e) => e.includes('ref.workspace_id'))).toBe(true);
    expect(errors.some((e) => e.includes('ref.element_id'))).toBe(true);
  });

  it('rejects a schema_version that is not semver', () => {
    const descriptor = { ...validOnshapeDescriptor(), schema_version: 'v1' };
    const errors = validateCadModelDescriptor(descriptor);
    expect(errors.some((e) => e.startsWith('schema_version:'))).toBe(true);
  });

  it('rejects a variable_map key not in the 25 measurement variables', () => {
    const descriptor = {
      ...validOnshapeDescriptor(),
      variable_map: { Not_A_Real_Key: 'renamed' },
    };
    const errors = validateCadModelDescriptor(descriptor);
    expect(errors.some((e) => e.includes('variable_map.Not_A_Real_Key'))).toBe(true);
  });

  it('rejects an empty-string variable_map value', () => {
    const descriptor = {
      ...validOnshapeDescriptor(),
      variable_map: { Leg_Length: '' },
    };
    const errors = validateCadModelDescriptor(descriptor);
    expect(errors.some((e) => e.includes('variable_map.Leg_Length'))).toBe(true);
  });

  it('accepts a null variable_map', () => {
    const descriptor = { ...validOnshapeDescriptor(), variable_map: null };
    expect(validateCadModelDescriptor(descriptor)).toEqual([]);
  });

  it('accepts an omitted variable_map', () => {
    const descriptor = validOnshapeDescriptor() as Record<string, unknown>;
    delete descriptor.variable_map;
    expect(validateCadModelDescriptor(descriptor)).toEqual([]);
  });

  it('accepts a variable_map that renames a subset of the 25 keys', () => {
    const descriptor = {
      ...validOnshapeDescriptor(),
      variable_map: { Leg_Length: 'legLength', S1_ISW: 's1isw' },
    };
    expect(validateCadModelDescriptor(descriptor)).toEqual([]);
  });
});

describe('applyVariableMap', () => {
  it('is the identity when map is null', () => {
    const values = { Leg_Length: 400, S1_ISW: 10 };
    expect(applyVariableMap(values, null)).toEqual(values);
  });

  it('is the identity when map is undefined', () => {
    const values = { Leg_Length: 400, S1_ISW: 10 };
    expect(applyVariableMap(values, undefined)).toEqual(values);
  });

  it('is the identity when map is an empty object', () => {
    const values = { Leg_Length: 400, S1_ISW: 10 };
    expect(applyVariableMap(values, {})).toEqual(values);
  });

  it('renames mapped keys and leaves unmapped keys as-is', () => {
    const values = { Leg_Length: 400, S1_ISW: 10, S1_ISD: 20 };
    const map = { Leg_Length: 'legLength' };
    expect(applyVariableMap(values, map)).toEqual({
      legLength: 400,
      S1_ISW: 10,
      S1_ISD: 20,
    });
  });

  it('does not mutate the input values object', () => {
    const values = { Leg_Length: 400 };
    applyVariableMap(values, { Leg_Length: 'legLength' });
    expect(values).toEqual({ Leg_Length: 400 });
  });
});
