# @zells/shared

Single source of truth for anything two or more parts of the system must agree
on, starting with the frozen 25-variable measurement contract described in
`docs/DESIGN.md` (sections 6 and 8, gotcha 2).

## The frozen contract

`Leg_Length` plus four cross-sections (S1 to S4, at 20, 40, 60, and 80 percent
of leg length measured up from the bottom of the ankle; `Leg_Length` runs from
the bottom of the ankle to the knee), each with six dimensions: `ISW`, `ISD`,
`ICW`, `ICD`, `OW`, `OD`. That is 1 plus 24, 25 variables total. The names
must match the Onshape parametric model exactly. The extraction script, the
TypeScript types in this package, and the Onshape client all validate against
the same JSON Schema file so the three cannot drift apart.

**Status: CONFIRMED (schema 1.0.0).** The 25 variable names and the slice
position convention were confirmed against the Onshape model's variable table
on 2026-07-02. Any future rename requires a coordinated schema version bump
across this package, the Python pipeline, and the Onshape model, never an ad
hoc edit.

## Units

All measurement values are **millimeters** everywhere in this schema and in
every TypeScript type derived from it. Onshape itself stores everything in
meters internally; the conversion to meters happens exactly once, inside the
pipeline's Onshape client. Nothing outside that client should ever see meters.

## Layout

- `schema/measurements.schema.json` - the canonical JSON Schema (draft
  2020-12). This is the cross-language source of truth: both this package and
  the Python pipeline validate against this exact file, not a copy of it.
- `src/measurements.ts` - `MEASUREMENT_KEYS`, `MeasurementKey`, and
  `Measurements` (TypeScript types derived from the schema).
- `src/validate.ts` - `validateMeasurements()`, which compiles and runs the
  JSON Schema (via Ajv) against arbitrary input and returns either the typed,
  validated measurements or a list of human-readable error strings.
- `src/states.ts` - the pipeline step, scan status, and order status state
  machines used across the app and the worker.

## How the Python pipeline consumes this

The Python pipeline does not import this TypeScript package. It reads the
same schema file directly from its checked-out path in the monorepo:
`packages/shared/schema/measurements.schema.json`. Loading that file with any
JSON Schema draft 2020-12 validator (for example `jsonschema` in Python) gives
the pipeline the identical validation rules as the TypeScript side, with no
duplicated logic to keep in sync.

## Running tests

From this package directory:

```
pnpm test
```

Or from the repo root, as part of the full workspace test run:

```
pnpm -r test
```

The test suite includes an anti-drift check that fails if the JSON Schema
file on disk ever diverges from what the TypeScript module loads at runtime.
