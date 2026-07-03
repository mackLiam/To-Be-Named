# services/pipeline - scan to STL worker

Python 3.12 worker: downloads an uploaded leg scan mesh, extracts the frozen
25-variable measurement set, pushes it to Onshape, exports a print-ready
STL, and advances the job through the Postgres-backed pipeline queue. See
`docs/DESIGN.md` sections 6, 7, and 9 for the full architecture and
rationale, and the root `CLAUDE.md` for repo-wide conventions.

**Status:** the 25 variable names and slice positions are CONFIRMED against
the Onshape model (2026-07-02, schema 1.0.0): slices at 20/40/60/80% of
`Leg_Length` measured up from the bottom of the ankle. The ISW/ISD/ICW/ICD/
OW/OD geometric definitions used by `extraction/measure.py` are still one
documented interpretation pending a sketch-level walkthrough with the CAD
collaborator; treat the six per-slice dimensions as provisional until then.

## What it does

1. **Measure step:** downloads the mesh from the Supabase `meshes` bucket,
   validates it as untrusted input (extension allowlist, size cap, vertex
   count cap, degenerate-mesh rejection), runs PCA-based extraction (leg
   axis + four cross-section slices at 20/40/60/80% of leg length), checks
   every value against the schema's plausibility gates, and stores the
   result in the `measurements` table keyed by `(scan_id,
   extraction_version)`.
2. **CAD step:** pushes the 25 variables to Onshape (millimeters converted
   to meters exactly once, in `onshape/client.py`), triggers regeneration,
   exports an STL, and uploads it to the `stls` bucket.
3. Every step is idempotent by `job_id`/`scan_id`; any exception in a step
   handler fails that job (via `fail_pipeline_job`) without stopping the
   worker loop.

## Running locally

```sh
cd services/pipeline
python3.12 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

ruff check .
pytest

uvicorn zells_pipeline.api:app --reload   # health endpoint only
python -m zells_pipeline.main             # health endpoint + worker loop
```

(A root-level `make` target wrapping the above will exist once the
monorepo's Makefile is scaffolded; until then, run the commands above
directly from `services/pipeline`.)

## Dry-run mode

If `ONSHAPE_ACCESS_KEY`/`ONSHAPE_SECRET_KEY` are unset, `OnshapeClient` runs
in dry-run mode: it logs the call it would have made (set variables,
trigger regeneration, export STL) and returns canned results instead of
touching the network. This lets the queue, extraction, and state-machine
plumbing be exercised end to end without an Onshape account. `GET
/healthz` reports the current `dry_run` state.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string for the `pipeline_jobs` queue. |
| `SUPABASE_URL` | yes | Supabase project URL, used for the Storage REST API. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service role key. Server-side only; never logged, never sent to any client. |
| `ONSHAPE_ACCESS_KEY` | no | Onshape API access key. Unset means dry-run mode. |
| `ONSHAPE_SECRET_KEY` | no | Onshape API secret key. Unset means dry-run mode. |
| `ONSHAPE_BASE_URL` | no | Defaults to `https://cad.onshape.com`. |
| `ONSHAPE_DOCUMENT_ID` | yes (non-dry-run) | Parametric shin guard document id. |
| `ONSHAPE_WORKSPACE_ID` | yes (non-dry-run) | Workspace id within that document. |
| `ONSHAPE_ELEMENT_ID` | yes (non-dry-run) | Part studio element id within that workspace. |
| `PIPELINE_ENV` | no | Defaults to `development`. |
| `PIPELINE_MAX_MESH_MB` (`max_mesh_mb`) | no | Untrusted-upload size cap in MB. Defaults to 100. |
| `MAX_VERTICES` (`max_vertices`) | no | Untrusted-mesh vertex count cap. Defaults to 2,000,000. |
| `SCHEMA_PATH` | no | Path to the measurement JSON Schema. Defaults to the in-repo `packages/shared/schema/measurements.schema.json`; the Docker image sets this explicitly since its build context does not include the whole monorepo. |

Note: this table documents the variables this service reads; the
repo-root `.env.example` is out of scope for this change (see
`src/zells_pipeline/config.py` for the authoritative field list and
defaults).

## Docker

Build context must be the **repo root**, not `services/pipeline`, because
the image copies `packages/shared/schema/measurements.schema.json` in
alongside the service source:

```sh
docker build -f services/pipeline/Dockerfile -t zells-pipeline .
```

## Tests

`pytest` in `tests/`, no network and no real database: mesh fixtures are
synthetic (generated in code with trimesh), and the job store / storage
client / Onshape HTTP transport are all faked or mocked. Golden-file tests
against real, hand-verified OBJ scans (`tests/fixtures/`, the only place
mesh binaries are allowed in git) are a follow-up once real scan data
exists, per `docs/DESIGN.md` section 6.
