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
2. **The 25-variable schema is a frozen contract**: `Leg_Length` + 4 slices (S1-S4 at
   20/40/60/80% of leg length) × 6 dims (`ISW`,`ISD`,`ICW`,`ICD`,`OW`,`OD`). Names must
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

## Current phase

Phase 0 - prove the pipeline (see DESIGN.md §11): real scan → extraction → Onshape →
printed guard with zero manual CAD. Auth/payments deliberately deferred until this works.
Open blocker: confirming the 25 variable names with the CAD collaborator.
