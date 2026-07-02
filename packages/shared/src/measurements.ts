// The frozen 25-variable measurement contract (DESIGN.md section 8, gotcha 2).
// Names are DRAFT pending confirmation with the CAD collaborator against the
// Onshape model. Do not rename ad hoc: this file, the JSON schema in
// ../schema/measurements.schema.json, the Python extraction script, and the
// Onshape client must all agree on these exact names.

export const SCHEMA_VERSION = '0.1.0-draft';

export const MEASUREMENT_KEYS = [
  'Leg_Length',
  'S1_ISW',
  'S1_ISD',
  'S1_ICW',
  'S1_ICD',
  'S1_OW',
  'S1_OD',
  'S2_ISW',
  'S2_ISD',
  'S2_ICW',
  'S2_ICD',
  'S2_OW',
  'S2_OD',
  'S3_ISW',
  'S3_ISD',
  'S3_ICW',
  'S3_ICD',
  'S3_OW',
  'S3_OD',
  'S4_ISW',
  'S4_ISD',
  'S4_ICW',
  'S4_ICD',
  'S4_OW',
  'S4_OD',
] as const;

export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

export type Measurements = Record<MeasurementKey, number>;
