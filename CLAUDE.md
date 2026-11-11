# FORMS

Custom-fit, 3D-printed soccer shin guards. Phone scan → measurement extraction →
parametric CAD → print-ready STL, fully automated (no manual CAD per customer).
Full architecture, rationale, and roadmap: **`docs/DESIGN.md`** - read it before
architectural decisions; update it when decisions change.

## Repo structure (monorepo - pnpm workspaces + Turborepo)

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
- Branding: product name FORMS (working name; single source is `BRAND_NAME` in
  packages/shared/src/brand.ts, read by apps/app, apps/web, and app.config.ts).
  Palette: card yellow #EDD27A (background), brick red #B0362C (brand/wordmark;
  action fills use brick 600 #9E352B for AA), stud brown #3A2E26 (text, dark
  surfaces), bright brick #E0513F (on brown only). Fonts Outfit + Manrope.
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

- **Pre-approved here (personal repo):** status, add, commit, push, pull, fetch,
  rebase, branch, merge, checkout, switch. When a task ends in a commit, commit and
  push without asking. Always ask first: force push, reset --hard, clean,
  filter-branch/filter-repo, deleting branches. Enforced by the global hook
  `~/.claude/hooks/git-gate.sh` (this repo is its only entry in
  `~/.claude/git-allowed-repos`); it also asks when a git command is chained with a
  non-git one, so run git commands on their own.
- **Parallel sessions share this checkout and its index.** Stage and commit in one
  step with explicit paths; never `git add -A` or `git add .`; never stash.
- Commit straight to `develop` (its PR-only rule is bypassed on purpose). `main` is
  release-only and changes only via PR from `develop`. Optional feature branches:
  `type/short-description`, merged back into `develop`.
- **Conventional Commits, always:** `type(scope): short summary`, blank line, then a
  body saying what changed and why. Types: `feat`, `fix`, `chore`, `docs`,
  `refactor`, `test`, `ci`, `perf`. Scope: one or two words (`app`, `web`,
  `pipeline`, `shared`, `scan`, `onshape`, ...).
- **Never add a Co-Authored-By line, "Generated with Claude" footer, or any AI
  attribution to commits, PRs, or code.** No exceptions.

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

## Operating procedure (summary; full text in docs/OPERATING-PROCEDURE.md)

Read docs/OPERATING-PROCEDURE.md before any nontrivial task (anything beyond a
single file with no contract, migration, UI or security surface). The loop:
classify the task (trivial / nontrivial / human-only, and never simulate
human-only work); gather context from the docs and code before planning; write
the plan down with contracts pinned verbatim and migration numbers reserved;
delegate bounded tasks to subagents with the seven-part brief; review what
comes back adversarially; run the verification commands yourself; commit per
logical scope.

| Scope | Commands (from repo root) |
|---|---|
| All JS/TS | `pnpm turbo run build typecheck test` then `pnpm format:check` |
| One JS package | `pnpm --filter @forms/shared build`, `... typecheck`, `... test` (same pattern for `@forms/app`, `@forms/web`; app has no build script) |
| Pipeline | `cd services/pipeline && .venv/bin/ruff check . && .venv/bin/pytest` |
| Everything | `make lint typecheck test` |

CI (.github/workflows/ci.yml) runs the same steps; local green must mean CI
green. Report failures verbatim; never claim green without running.

## Current phase

Phase 0 - prove the pipeline (see DESIGN.md §11): real scan → extraction → Onshape →
printed guard with zero manual CAD. As of 2026-11-10: Onshape API access works; a
guard printed from hand-set Onshape values fit well; the slice variables' meaning
was read from the model (crest-relative points, DESIGN.md 12.2), which the current
extraction and schema ranges do not match. Next, per docs/SCAN-V3-PLAN.md: schema
1.1.0 plus crest-relative extraction (blocks automated CAD), tape ground truth,
the automated round trip, then the sweep capture. Still open: on-device capture
runs, a LiDAR iPhone trial.
