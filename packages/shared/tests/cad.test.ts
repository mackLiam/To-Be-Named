import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../src/measurements.js';
import { applyVariableMap, validateCadModelDescriptor } from '../src/cad.js';

function validOnshapeDescriptor() {
  return {
    provider: 'onshape' as const,
    schema_version: SCHEMA_VERSION,
    profile: { kind: 'identity' as const },
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
    profile: { kind: 'identity' as const },
    ref: {},
  };
}

function withProfile(profile: unknown) {
  return { ...validDryRunDescriptor(), profile };
}

function crest(wrap: unknown) {
  return withProfile({ kind: 'crest_spline_v1', wrap });
}

const goodWrap = { inner_shin: 0.35, inner_calf: 0.6, outer: 0.7 };

describe('profile', () => {
  const hasErr = (v: unknown, prefix: string) =>
    validateCadModelDescriptor(v).some((e) => e.startsWith(prefix));

  it('accepts identity and crest_spline_v1', () => {
    expect(validateCadModelDescriptor(withProfile({ kind: 'identity' }))).toEqual([]);
    expect(validateCadModelDescriptor(crest(goodWrap))).toEqual([]);
  });

  it('rejects a missing or non-object profile', () => {
    const d = validDryRunDescriptor() as Record<string, unknown>;
    delete d.profile;
    expect(hasErr(d, 'profile:')).toBe(true);
    for (const bad of [null, 'identity', 5, []]) {
      expect(hasErr(withProfile(bad), 'profile:')).toBe(true);
    }
  });

  it('rejects an unknown key inside profile', () => {
    expect(hasErr(withProfile({ kind: 'identity', extra: 1 }), 'profile.extra')).toBe(true);
  });

  it('rejects an unknown or missing kind', () => {
    expect(hasErr(withProfile({ kind: 'spline' }), 'profile.kind')).toBe(true);
    expect(hasErr(withProfile({}), 'profile.kind')).toBe(true);
  });

  it('rejects wrap on identity', () => {
    expect(hasErr(withProfile({ kind: 'identity', wrap: goodWrap }), 'profile.wrap')).toBe(true);
  });

  it('requires wrap to be an object for crest_spline_v1', () => {
    expect(hasErr(withProfile({ kind: 'crest_spline_v1' }), 'profile.wrap')).toBe(true);
    expect(hasErr(crest('x'), 'profile.wrap')).toBe(true);
    expect(hasErr(crest(null), 'profile.wrap')).toBe(true);
  });

  it('rejects missing and unknown wrap keys', () => {
    expect(hasErr(crest({ inner_shin: 0.3, inner_calf: 0.6 }), 'profile.wrap.outer')).toBe(true);
    expect(hasErr(crest({ ...goodWrap, extra: 0.5 }), 'profile.wrap.extra')).toBe(true);
  });

  it('rejects non-finite and non-number wrap values', () => {
    for (const bad of [NaN, Infinity, -Infinity, '0.5', null]) {
      expect(hasErr(crest({ ...goodWrap, inner_shin: bad }), 'profile.wrap.inner_shin')).toBe(true);
      expect(hasErr(crest({ ...goodWrap, outer: bad }), 'profile.wrap.outer')).toBe(true);
    }
  });

  it('enforces 0 < inner_shin < inner_calf < 1', () => {
    expect(hasErr(crest({ ...goodWrap, inner_shin: 0 }), 'profile.wrap.inner_shin')).toBe(true);
    expect(hasErr(crest({ ...goodWrap, inner_shin: -0.1 }), 'profile.wrap.inner_shin')).toBe(true);
    expect(hasErr(crest({ ...goodWrap, inner_calf: 0.35 }), 'profile.wrap.inner_calf')).toBe(true);
    expect(hasErr(crest({ ...goodWrap, inner_calf: 0.2 }), 'profile.wrap.inner_calf')).toBe(true);
    expect(hasErr(crest({ ...goodWrap, inner_calf: 1 }), 'profile.wrap.inner_calf')).toBe(true);
    expect(hasErr(crest({ ...goodWrap, inner_calf: 1.2 }), 'profile.wrap.inner_calf')).toBe(true);
  });

  it('enforces 0 < outer < 1', () => {
    for (const bad of [0, 1, -0.5, 1.5]) {
      expect(hasErr(crest({ ...goodWrap, outer: bad }), 'profile.wrap.outer')).toBe(true);
    }
  });

  it('accepts outer equal to inner values (no ordering rule on outer)', () => {
    expect(validateCadModelDescriptor(crest({ ...goodWrap, outer: 0.35 }))).toEqual([]);
  });

  it('pins the schema version', () => {
    expect(SCHEMA_VERSION).toBe('1.1.0');
  });
});

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

  it('accepts an omitted variable_kind', () => {
    expect(validateCadModelDescriptor(validOnshapeDescriptor())).toEqual([]);
  });

  it.each(['variable_studio', 'part_studio_features'])('accepts variable_kind %s', (kind) => {
    const descriptor = { ...validOnshapeDescriptor(), variable_kind: kind };
    expect(validateCadModelDescriptor(descriptor)).toEqual([]);
  });

  it.each(['feature_studio', '', null, 1])('rejects variable_kind %j', (kind) => {
    const descriptor = { ...validOnshapeDescriptor(), variable_kind: kind };
    const errors = validateCadModelDescriptor(descriptor);
    expect(errors.some((e) => e.startsWith('variable_kind:'))).toBe(true);
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
