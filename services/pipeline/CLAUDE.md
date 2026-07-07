# services/pipeline - worker context

Python 3.12 worker: mesh in, 25 measurements out, CAD model regenerated, STL out.
Read the root CLAUDE.md and docs/DESIGN.md sections 6-7 first. This file adds the
reasoning that produced this code, so future changes stay consistent with it.

## Mental model

The worker is a queue consumer over an explicit state machine in Postgres.
Nothing here is a user-facing API; FastAPI exists only for health/ops surface.
Every piece of compute is stateless and keyed by job_id, so N workers can run
in parallel without coordination. If you are about to add worker-local state
(a cache, a lock, an in-memory map that must survive between jobs), stop: put
it in Postgres or drop the idea.

## Load-bearing invariants (in priority order)

1. **Millimeters everywhere, converted once.** Every function in this service
   computes in mm. Conversion to a CAD backend's native unit happens exactly
   once, inside the CAD provider layer (historically `mm_to_m` in the Onshape
   client). If you find yourself multiplying or dividing a measurement by 1000
   anywhere else, you are creating the bug class this rule exists to prevent.
   Keep the conversion a pure function with no HTTP knowledge so it stays
   independently testable.
2. **Fail the job, never the worker.** `process_job` wraps every handler; any
   exception marks the job failed and the loop continues. When you raise, decide
   retriability at the raise site, not in the catch site: a typed exception
   (MeshValidationError, GateViolationError, bad CAD descriptor) means "this
   input will never succeed, dead-letter it now"; anything else is presumed
   transient and gets backoff via the queue's run_after. When adding a new
   failure mode, ask "would running this again with the same input succeed?"
   and pick the exception type accordingly.
3. **Idempotency by construction, not by checking.** Handlers do not query
   "did I already run?"; they write in ways where re-running lands on the same
   result: measurements upsert on (scan_id, extraction_version), STL upload
   with x-upsert to a path derived from scan_id/job_id, storage deletes treat
   404 as success. Extend new handlers the same way: derive every write key
   from job/scan ids, use upsert semantics, treat already-done as done.
4. **Uploaded meshes are hostile input.** Size caps and vertex caps before
   parsing, parse failures are non-retriable job failures, timeouts bound
   everything. The threat model is not malice only; it is also a corrupted
   capture wedging the queue.
5. **Plausibility gates before CAD.** Out-of-range measurements must become a
   user-facing "please rescan" failure. Garbage geometry must never reach a
   printer. The gates come from the shared JSON Schema, not from constants in
   this package.

## The 25-variable contract

`contract.py` loads the frozen JSON Schema from packages/shared (single source
of truth; the Docker image copies the schema file and points SCHEMA_PATH at
it). MEASUREMENT_KEYS, SCHEMA_VERSION, and the plausible ranges all derive
from that file. Never hardcode a variable name or range here. If the schema
ever changes, it is a cross-repo versioned event (schema_version bump,
extraction_version bump, collaborator sign-off), not an edit.

`EXTRACTION_VERSION` (extraction/measure.py) versions the algorithm, separate
from the schema version. Bump it whenever extraction output could change for
the same mesh; the measurements table keys on (scan_id, extraction_version)
precisely so old and new algorithm outputs can coexist and be compared.

## CAD provider layer (zells_pipeline/cad/)

CAD generation is behind a provider abstraction so the product can serve
multiple guard designs and swap backends (DESIGN.md section 7 exit strategy:
CadQuery/build123d later, no external API, no rate limits).

- A **CadModelDescriptor** (per-product `cad_model` jsonb in Postgres, mirrored
  as a TS type in packages/shared) says which provider, which model ref, and an
  optional variable_map renaming the 25 schema names to the model's variable
  names. Descriptor problems are non-retriable: the job fails with a reason an
  admin can act on.
- A **CadProvider** exposes `generate_stl(job_id, values_mm, model) -> bytes`.
  Providers own their internals (Onshape: set variables, regenerate, export)
  and their own unit conversion. The runner knows nothing about any backend.
- The default descriptor (job with no order/product, i.e. Phase 0 scans) is
  built from Settings' onshape_* env fields; with no Onshape credentials it
  degrades to the dry-run provider so the whole pipeline is exercisable with
  zero accounts.
- Log per-job CAD latency from day one: Onshape throughput is the known
  scaling ceiling and the code-CAD port decision (December memo) is made from
  this number.

To add a provider: implement the protocol, register it, define its ref shape
in the descriptor validation on BOTH sides (Python here, TS in
packages/shared/src/cad.ts), add tests for ref validation and unit conversion.
The two validators must stay in lockstep; treat them as one change.

## Why the seams are where they are

JobStore and StorageClient are Protocols with production implementations in
the same module. This is deliberate: the test suite for the runner uses fakes
and never touches a network or Postgres, which keeps it fast and means the
worker logic is verifiable on any machine with no credentials. When you add a
store/storage method, add it to the Protocol first, then both the production
class and the test fake. If a new dependency wants to be called from a
handler, give it the same treatment: small Protocol, production impl, fake.

DRY_RUN patterns are graded by blast radius:
- Onshape dry_run is **derived** (no creds means dry-run) because the failure
  mode of getting it wrong is a failed API call: annoying, recoverable.
- Retention dry_run **defaults to true and must be explicitly disabled**
  because the failure mode is irreversible deletion of minors' body-scan data.
Rule to reuse: reversible-if-wrong can infer safety from context; irreversible
must require an explicit operator decision.

## Testing doctrine

- Pure core, thin IO shell. Geometry math (extraction) is tested on synthetic
  meshes with known dimensions (scripts/make_synthetic_fixture.py) plus golden
  files with hand-verified expectations. Transport code is tested by mocking
  httpx and asserting on the exact URL paths and payloads, because the URL
  path IS the contract with Onshape.
- Every bug class named in root CLAUDE.md gotchas has at least one test
  pinning it: unit boundary, name mismatch, oversized mesh, gate violation,
  poison job not killing the worker.
- If you cannot test something without credentials, restructure until you can;
  the only untestable residue should be the production Protocol impls, which
  are kept so thin that reading them is the review.

## Operational posture

- Queue helpers (claim/advance/complete/fail) live in SQL migrations, use
  SKIP LOCKED, backoff, and a dead-letter state. The worker never sleeps
  holding a job; polling waits happen via the queue's run_after, not
  time.sleep in a handler.
- Secrets only from environment; Settings redacts them in repr so a stray
  log or traceback cannot leak them. Never put a secret in an exception
  message; exceptions end up in the pipeline_jobs.error column, which admins
  read in a browser.
- Concurrency against Onshape stays at 1-2 until measured latency says
  otherwise (rate limits are per account).

## Subagent brief (when you are delegated work here)

- The five load-bearing invariants above are your review rubric; violating
  any of them is a rejected diff. In particular: mm everywhere except inside
  the CAD provider, retriability decided at the raise site with a typed
  exception, write keys derived from job/scan ids.
- New IO dependency: define the small Protocol first, then the production
  impl, then the test fake. If you cannot test your change without
  credentials, restructure it until you can; do not mock deeper.
- If your change requires the TS mirror in packages/shared to move, do not
  edit it unless your prompt includes those paths; return the exact required
  TS change instead so the orchestrator can run it as a lockstep change.
- Never put a secret or mesh contents in an exception message; errors land
  in pipeline_jobs.error and are read in a browser.
- Verify before returning:
  `cd services/pipeline && .venv/bin/ruff check . && .venv/bin/pytest`
  Return the output verbatim. Leave all changes uncommitted.
