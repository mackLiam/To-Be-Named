# services/pipeline - scan→STL worker

Python 3.12 worker (FastAPI for health/admin endpoints; consumes the Postgres-backed
job queue). Runs on Fly.io/Railway as a Docker container.

Responsibilities (see `docs/DESIGN.md` §6):

1. Fetch OBJ from Supabase Storage (untrusted input: size/vertex caps, timeouts).
2. Extract measurements - PCA leg axis, slices S1-S4 at 20/40/60/80%, 6 dims each
   (ISW, ISD, ICW, ICD, OW, OD) + Leg_Length = 25 variables. Validate against
   plausibility ranges; out-of-range → job fails with a user-facing rescan reason.
3. Push variables to Onshape REST API (mm→meters conversion happens HERE and only
   here), poll regeneration, export STL to Storage.
4. Advance the order state machine; every step idempotent by job_id.

Key deps (when scaffolded): trimesh, numpy, scipy, httpx, pydantic.
`extract_shin_measurements.py` (existing prototype) migrates here.
Golden-file tests: real OBJ fixtures + hand-verified expected measurements under
`tests/fixtures/` (the only place mesh binaries are allowed in git).
