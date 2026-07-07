# Zells

Custom-fit, 3D-printed soccer shin guards. Phone scan → measurement extraction →
parametric CAD → print-ready STL, fully automated (no manual CAD per customer).
Full architecture, rationale, and roadmap: **`docs/DESIGN.md`** - read it before
architectural decisions; update it when decisions change.

## Repo structure (monorepo - pnpm workspaces + Turborepo, planned)

```
apps/app/          Expo Router universal product app - ships iOS + Android + web (app.zells.com)
apps/web/          Next.js - marketing site (zells.com) + internal admin panel
services/pipeline/ Python (FastAPI) worker - measurement extraction, Onshape, STL export
packages/shared/   Shared TypeScript types + the frozen 25-variable measurement JSON Schema
docs/              Design docs (DESIGN.md is the source of truth)
```

## Stack

- **App:** React Native + Expo (custom dev client via EAS - NOT Expo Go), Expo Router, TypeScript
- **Capture:** Swift native module wrapping ObjectCaptureSession/PhotogrammetrySession (iOS 17+, LiDAR)
- **Web:** Next.js on Vercel (marketing + admin only; the product web app is the Expo web build)
- **Backend:** Supabase - Auth, Postgres with RLS, Storage; Postgres-backed job queue (pgmq/Graphile Worker)
- **Pipeline:** Python 3.12, trimesh/numpy/scipy; Onshape REST API for CAD generation
- **Payments:** Stripe. **Errors:** Sentry. **Analytics:** PostHog.

## Critical gotchas (violating these breaks the product)

1. **Onshape stores everything in meters** regardless of display units. The pipeline
   computes in **mm** and converts to meters exactly once, in the Onshape client layer.
2. **The 25-variable schema is a frozen contract (1.0.0, names confirmed
   2026-07-02)**: `Leg_Length` (bottom of ankle to knee) + 4 slices (S1-S4 at
   20/40/60/80% of leg length measured up from the bottom of the ankle, so S1 is
   nearest the ankle) × 6 dims (`ISW`,`ISD`,`ICW`,`ICD`,`OW`,`OD`). Names must
   match the Onshape model exactly. Single source of truth: JSON Schema in
   `packages/shared` - extraction script, TS types, and Onshape client all validate
   against it. Never rename ad hoc.
3. **PhotogrammetrySession does not work in Expo Go.** Capture requires the custom dev
   client + native module + EAS build, on a physical LiDAR iPhone.
4. **OBJ files have no units.** Non-LiDAR photogrammetry meshes have arbitrary scale.
   Uploaded meshes need a scale cross-check before measurements are trusted.
5. **Scans are sensitive personal data** (body scans, likely minors). RLS on every
   table; private buckets + short-lived signed URLs; raw meshes auto-deleted after
   delivery (measurements JSON kept); no secrets in client bundles ever - only
   `EXPO_PUBLIC_*`/`NEXT_PUBLIC_*` values may reach the client.
6. **Pipeline steps are idempotent, keyed by job_id**, and modeled as an explicit state
   machine in Postgres. Uploaded meshes are untrusted input: size caps, timeouts,
   fail-the-job-never-the-worker.
7. **Measurement validation gates:** every extracted value checked against
   human-plausible ranges; out-of-range → user-facing "rescan" failure, never garbage
   geometry sent to print.

## Conventions

- TypeScript everywhere in JS-land; shared types live in `packages/shared`, never duplicated.
- Branding: white/orange/navy; fonts Outfit + Manrope.
- Secrets: `.env` (gitignored). Template: `.env.example` - keep it updated when adding vars.
- Mesh/STL binaries never in git (gitignored) except small test fixtures under `tests/fixtures/`.
- **No emojis. Anywhere.** Not in code, comments, docs, READMEs, commit messages, UI copy,
  or chat output for this repo. Use plain text (e.g. "Done:", "TODO:") instead.
- **No em dashes (U+2014) or en dashes (U+2013). Anywhere.** Same scope as the emoji
  rule. Use a comma, colon, period, parentheses, or plain hyphen (-) instead.

## Engineering standards (apply to ALL work, all agents)

Every agent (main session and every subagent) follows these on every feature, fix,
or refactor. Not optional, not deferred to "later".

- **Tests are part of the feature.** Any new behavior or bug fix ships with test
  cases in the same change: unit tests for logic, schema-validation tests for
  anything touching the 25-variable contract, and edge/failure cases (bad mesh,
  out-of-range measurement, API error), not just the happy path. TS: Vitest in the
  owning package. Python: pytest in `services/pipeline`. If code is genuinely
  untestable, say so explicitly and why, instead of silently skipping tests.
- **Design for scale, within Phase 0 cost discipline.** No per-customer manual
  steps, no unbounded queries (paginate/limit), no loading whole meshes into
  memory when streaming works, stateless workers keyed by job_id so they can be
  parallelized, and no O(n^2)-over-customers patterns. Scalable design first;
  paid infrastructure still only when volume demands it.
- **Security review is part of every change.** Before finishing, check the change
  against: RLS on every table (deny-by-default), no secrets client-side (only
  `EXPO_PUBLIC_*`/`NEXT_PUBLIC_*`), private buckets + short-lived signed URLs,
  all user input (uploads, params, webhooks) validated and size/time capped,
  no injection (parameterized queries only), authz checks server-side never
  client-side, and dependencies pinned. Scans are minors' body data: when in
  doubt, lock it down.

## Git rules (strict)

- **Git is pre-approved in this repo (explicit exception to the global rule).** This
  is a personal repo: run non-destructive git commands (status, add, commit, push,
  pull, fetch, rebase, branch, merge, checkout, stash) without asking first, in chat
  or otherwise. When a task naturally ends in a commit, commit and push without
  prompting. Destructive operations still require explicit approval every time:
  force push, reset --hard, clean, filter-branch/filter-repo, deleting remote branches.
- Committing directly to `develop` is allowed (the remote's PR-only rule on `develop`
  is bypassed intentionally). `main` is release-only and changes ONLY via PR from
  `develop` - never commit or push to `main` directly.
- Feature branches are optional, for larger or riskier work; name them
  `type/short-description` (e.g. `feat/scan-upload`, `fix/onshape-units`) and merge
  back into `develop`.
- **Commit messages - Conventional Commits, always:**
  - Format: `type(scope): short summary` on line 1, blank line, then a longer body
    explaining what changed and why.
  - `type`: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`.
  - `scope`: one or two words for the part touched (`app`, `web`, `pipeline`, `shared`,
    `repo`, `docs`, `scan`, `onshape`, etc.).
  - Example:
    ```
    feat(pipeline): add measurement plausibility gates

    Reject extracted values outside human-plausible ranges before CAD
    generation so a bad scan fails with a rescan prompt instead of
    producing wrong geometry.
    ```
- **Never add a Co-Authored-By line, "Generated with Claude" footer, or any AI
  attribution to commits, PRs, or code.** No exceptions.
- Never force-push shared branches.

## Reasoning playbook (read this; it is how the codebase was built)

Distilled decision heuristics from the sessions that built this repo. Apply them
to new work; they explain why the code looks the way it does. Per-package depth
lives in services/pipeline/CLAUDE.md, packages/shared/CLAUDE.md,
apps/app/CLAUDE.md, apps/web/CLAUDE.md - read the one for the area you touch.

1. **Contract first, implementations second.** When two languages or services
   share a data shape (the 25 variables, CAD descriptors, state enums), freeze
   the exact JSON shape before writing either side, write validators on BOTH
   sides, and change them only in lockstep. Most cross-service bugs here are
   shape drift; this kills them at the boundary.
2. **One boundary per lossy conversion.** Units (mm to meters), naming
   (schema names to model variable names), trust (client claims to RLS-checked
   facts) each convert in exactly one named place. If a conversion appears in
   a second place, that is the bug, even if both copies are currently correct.
3. **Seams are Protocols sized to the caller's needs.** External systems
   (Postgres, storage, CAD backends) sit behind small interfaces defined by
   what the caller uses, not by what the vendor offers. Production impl lives
   next to the interface; tests use fakes; no test needs credentials. If code
   is hard to test, move the seam instead of mocking deeper.
4. **Decide retriability where the error is raised.** Every failure is typed
   at the raise site as "same input will never succeed" (non-retriable, dead
   letter, user-facing reason) or "presumed transient" (backoff retry). Catch
   sites stay generic: fail the job, never the worker.
5. **Safety defaults scale with reversibility.** Reversible risk may infer
   safe mode from context (Onshape dry-run when creds absent). Irreversible
   risk (deleting scan data) defaults OFF and requires an explicit operator
   flag to arm. Never infer permission to destroy.
6. **Idempotency by construction.** Derive write keys from job/scan ids, use
   upserts, treat already-done (404 on delete, existing row) as success. Do
   not write "check if already ran" code; write code where re-running lands in
   the same state.
7. **Pure core, thin shell.** Geometry, validation, pagination, formatting:
   pure functions, heavily tested. IO wrappers: so thin that reading them is
   the review. When a component or handler grows logic, extract it down.
8. **Comments state constraints, not narration.** Write a comment only for
   what the code cannot say: why a bound exists, what invariant a caller must
   hold, which document froze a decision. Cite DESIGN.md sections.
9. **Where truth lives.** Architecture and its rationale: docs/DESIGN.md
   (update it in the same change that changes a decision). Sequencing and exit
   gates: docs/ROADMAP.md (do not start next month early if this month's gate
   is red). Contract: packages/shared. Everything else is implementation.
10. **Verification standard.** A change is done when the owning package's CI
    commands (see .github/workflows/ci.yml and Makefile) pass locally and the
    change includes its tests. Report failures verbatim; never claim green
    without running.

## Operating procedure (plan, delegate, review, verify)

This is the loop that built the repo, written down so any orchestrating model
can reproduce it by following procedure instead of improvising. The quality
came from the loop, not from any one model: gather context, plan against the
docs, delegate bounded tasks, review adversarially, verify by running
commands, commit per scope. Follow it literally for every nontrivial task.

### Step 0 - classify the task

- **Trivial** (single file, no contract, no migration, no UI, no security
  surface): do it inline. Tests, verification, and a commit still apply.
- **Nontrivial** (everything else): all steps below.
- **Human-only**: creating accounts, buying anything, physical scans and
  prints, App Store actions, legal review, anything requiring credentials
  only Liam holds. Do not attempt or simulate these; produce a precise list
  of what Liam must do, then stop.

### Step 1 - gather context before planning

Read, in this order, whatever the task touches. Never plan from memory of
what the repo "probably" contains; open the files.

1. Root CLAUDE.md gotchas and the playbook above.
2. docs/DESIGN.md sections relevant to the task (architecture truth).
3. docs/ROADMAP.md current week (is this on the critical path? gate green?).
4. The per-package CLAUDE.md of every workspace to be touched.
5. The actual contract code: packages/shared for shapes, supabase/migrations
   for the data model and RLS.

### Step 2 - plan before code

Write the plan down before any edit:

- Files and workspaces touched; split along workspace boundaries (pipeline /
  web / app / shared) when large; they rarely conflict.
- Contracts involved, with the exact JSON shape pasted into the plan.
- Migration numbers reserved, one per agent (two agents both creating 0006
  is the predictable collision).
- Tests that will ship with the change, including failure paths.
- Security checklist items the change triggers.
- Any DESIGN.md decision this changes: then DESIGN.md changes in the same
  commit series, and zells-architect sanity-checks the plan first.

Schema or CAD-descriptor changes are lockstep both-sides changes: plan the
TS and Python sides together before touching either.

### Step 3 - delegate to subagents

The orchestrator plans, delegates, reviews, integrates, and commits; it does
not write large diffs itself on multi-workspace tasks. Orchestrator context
is spent on judgment and review, not bulk code.

Model tier per subagent task:

- Routine and mechanical (apply an existing pattern, add tests mirroring
  existing ones, renames, UI tweaks inside the token system): cheapest
  capable model (Sonnet).
- New logic, contracts, security surface, geometry math, concurrency,
  migrations: the strongest model available.
- When unsure, go one tier up: a wrong cheap diff costs a review plus a redo.

Every subagent prompt contains all seven parts, every time:

1. The task in one paragraph, ending with explicit done-when criteria.
2. Exact paths the agent may change; everything else declared off-limits.
3. Contracts pinned verbatim: paste the schema fragment, enum, or JSON shape
   into the prompt. A reference ("see the schema") is not pinning; parallel
   agents drift unless the exact text is in front of both.
4. Binding rules: read the CLAUDE.md of the package being touched; tests
   ship in the same change; no emojis; no em/en dashes; comments state
   constraints only.
5. The exact verification commands that must pass (table in step 5).
6. What to return: change summary, verbatim test output, open questions.
   Changes stay uncommitted; the orchestrator commits.
7. What NOT to do: no schema changes, no new dependencies unless named, no
   migration numbers other than the reserved one, no scope creep "while I
   was in there".

UI work goes to (or gets reviewed by) zells-designer before shipping.

### Step 4 - review what comes back (adversarial, in order)

1. Diff scope: only the allowed paths? any new dependency, config edit,
   weakened assertion, or deleted test that was not asked for?
2. Contract drift: search the diff for the three house bug classes: restated
   variable names (typing S1_ISW instead of importing), a second unit
   conversion, string-literal states instead of shared enums.
3. Security checklist against the touched surface.
4. Tests: present, covering failure paths, and would actually fail if the
   bug existed. Read them; do not just count them.
5. Run the verification commands yourself. An agent's claim of green is a
   claim, not a run.

Large misses: reject and re-prompt with the gap named. Small deltas: hand-fix.

### Step 5 - verify and commit (the definition of green)

| Scope | Commands (from repo root) |
|---|---|
| All JS/TS | `pnpm turbo run build typecheck test` then `pnpm format:check` |
| One JS package | `pnpm --filter @zells/shared build`, `... typecheck`, `... test` (same pattern for `@zells/app`, `@zells/web`; app has no build script) |
| Pipeline | `cd services/pipeline && .venv/bin/ruff check . && .venv/bin/pytest` |
| Everything | `make lint typecheck test` |

CI (.github/workflows/ci.yml) runs the same steps; local green must mean CI
green. The orchestrator commits per logical scope with Conventional Commits
and pushes to develop. Report failures verbatim; never claim green without
running. If the change altered a decision or the sequencing, DESIGN.md or
ROADMAP.md changes ride the same commit series.

## Current phase

Phase 0 - prove the pipeline (see DESIGN.md §11): real scan → extraction → Onshape →
printed guard with zero manual CAD. Auth/payments deliberately deferred until this works.
Variable names confirmed and schema frozen at 1.0.0 (2026-07-02). Open blockers:
EAS dev build with the capture module on a LiDAR iPhone, dimension-semantics
walkthrough with the CAD collaborator, Onshape API access/keys.
