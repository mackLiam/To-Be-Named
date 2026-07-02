import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEASUREMENT_KEYS } from '../src/measurements.js';
import { measurementsSchema, validateMeasurements } from '../src/validate.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const schemaOnDiskPath = join(moduleDir, '..', 'schema', 'measurements.schema.json');

function validPayload(): Record<string, number> {
  const payload: Record<string, number> = { Leg_Length: 400 };
  for (const key of MEASUREMENT_KEYS) {
    if (key === 'Leg_Length') continue;
    payload[key] = 100;
  }
  return payload;
}

describe('measurements schema', () => {
  it('has exactly 25 properties, all required, additionalProperties false', () => {
    const properties = Object.keys(measurementsSchema.properties as Record<string, unknown>);
    expect(properties).toHaveLength(25);
    expect(measurementsSchema.additionalProperties).toBe(false);
    expect(measurementsSchema.required).toHaveLength(25);
    expect(new Set(measurementsSchema.required as string[])).toEqual(new Set(properties));
  });

  it('matches MEASUREMENT_KEYS exactly (set equality)', () => {
    const properties = Object.keys(measurementsSchema.properties as Record<string, unknown>);
    expect(new Set(MEASUREMENT_KEYS)).toEqual(new Set(properties));
    expect(MEASUREMENT_KEYS).toHaveLength(25);
  });

  it('is identical to the schema file on disk (anti-drift)', () => {
    const onDisk = JSON.parse(readFileSync(schemaOnDiskPath, 'utf-8'));
    expect(measurementsSchema).toEqual(onDisk);
  });

  it('accepts a valid, realistic payload', () => {
    const result = validateMeasurements(validPayload());
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.measurements.Leg_Length).toBe(400);
    }
  });

  it('rejects a payload missing a required key with a readable error', () => {
    const payload = validPayload();
    delete (payload as Record<string, unknown>).S2_ICW;
    const result = validateMeasurements(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('S2_ICW') && e.includes('required'))).toBe(true);
    }
  });

  it('rejects an out-of-range value with a readable error', () => {
    const payload = validPayload();
    payload.Leg_Length = 10;
    const result = validateMeasurements(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(
        result.errors.some(
          (e) => e.includes('Leg_Length') && e.includes('150') && e.includes('10'),
        ),
      ).toBe(true);
    }
  });

  it('rejects an extra, unrecognized key', () => {
    const payload = validPayload() as Record<string, unknown>;
    payload.Extra_Field = 42;
    const result = validateMeasurements(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('Extra_Field'))).toBe(true);
    }
  });

  it('rejects a non-number value', () => {
    const payload = validPayload() as Record<string, unknown>;
    payload.S1_OW = 'wide';
    const result = validateMeasurements(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('S1_OW') && e.includes('number'))).toBe(true);
    }
  });
});
