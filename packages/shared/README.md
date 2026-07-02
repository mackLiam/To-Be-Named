# packages/shared - cross-cutting contracts

Single source of truth for anything two or more parts of the system must agree on:

- **`measurements.schema.json`** - the frozen 25-variable measurement contract
  (Leg_Length + S1-S4 × ISW/ISD/ICW/ICD/OW/OD). Versioned (`schema_version`).
  The Python extractor, the TypeScript apps, and the Onshape client all validate
  against this file. Variable names must match the Onshape model exactly -
  confirm with the CAD collaborator before first freeze.
- TypeScript types: measurement payload, order/pipeline state machine states,
  API responses.
- Design tokens: brand colors (white/orange/navy), font names (Outfit, Manrope).

Rule: if a value or name is used by both an app and the pipeline, it lives here.
Units: all measurement values are **millimeters** everywhere in the system;
meters exist only inside the pipeline's Onshape client.
