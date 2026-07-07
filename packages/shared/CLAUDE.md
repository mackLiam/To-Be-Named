# packages/shared - contract package context

This package is the treaty between three codebases (Expo app, Next.js web,
Python pipeline). It holds contracts, not conveniences. Read root CLAUDE.md
gotcha 2 first.

## What belongs here

- The frozen 25-variable measurement JSON Schema (schema/measurements.schema.json).
- TypeScript types and validators derived from that schema.
- State enums for scans/orders/pipeline jobs (mirroring the SQL state machine).
- The CAD model descriptor type + validator (mirroring the Python validator in
  services/pipeline/src/zells_pipeline/cad/).

What does not belong here: UI helpers, fetch wrappers, anything platform
specific, anything only one consumer uses. When in doubt, keep it in the app
that needs it; promotion into shared is cheap later, demotion is churn.

## The frozen schema: rules of engagement

Schema 1.0.0 names were confirmed against the Onshape variable table on
2026-07-02. Treat every name and range as an external API owned jointly with
the CAD collaborator:

- Never rename, add, or remove a variable in a normal PR. A schema change is a
  versioned event: bump schema_version, coordinate the Onshape model, the
  Python contract module, and every validator in the same change, and record
  it in docs/DESIGN.md.
- Never restate the variable list anywhere. Python loads the schema file at
  runtime; TS derives from the exported constants here. If you catch yourself
  typing S1_ISW in a new file, import instead.
- Ranges in the schema are the plausibility gates. Loosening a range is a
  product decision (it changes what geometry can reach a printer), not a fix
  for a failing test.

## Cross-language mirroring discipline

Two validators exist for anything both TS and Python consume (measurements,
CAD descriptors). They are one logical artifact:

- Change them in the same commit, with equivalent test cases on both sides.
- The JSON shape is the contract; the validators are projections of it. If the
  sides ever disagree, the JSON Schema file (for measurements) or the
  documented shape in the Python cad module and src/cad.ts (for descriptors)
  wins, and the divergent side is the bug.
- Prefer dumb, explicit validation code over clever schema-driven generation:
  a reviewer must be able to diff the two languages by eye.

## Versioning semantics used across the product

- schema_version: shape and meaning of the 25 values. Frozen at 1.0.0.
- extraction_version: the algorithm that produced values (Python-owned).
- Rows in measurements are keyed (scan_id, extraction_version) so re-running a
  new algorithm on an old mesh creates a comparable row, never overwrites
  history from a different algorithm.

Consumers must always write and check schema_version rather than assuming;
that is what makes the eventual 1.1.0 survivable.
