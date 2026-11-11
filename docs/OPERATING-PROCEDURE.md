# Operating procedure (plan, delegate, review, verify)

Moved out of the root CLAUDE.md on 2026-11-10 to keep per-session context
small; CLAUDE.md keeps a summary and the verification table. Read this in
full before orchestrating any nontrivial task.

This is the loop that built the repo, written down so any orchestrating model
can reproduce it by following procedure instead of improvising. The quality
came from the loop, not from any one model: gather context, plan against the
docs, delegate bounded tasks, review adversarially, verify by running
commands, commit per scope. Follow it literally for every nontrivial task.

## Step 0 - classify the task

- **Trivial** (single file, no contract, no migration, no UI, no security
  surface): do it inline. Tests, verification, and a commit still apply.
- **Nontrivial** (everything else): all steps below.
- **Human-only**: creating accounts, buying anything, physical scans and
  prints, App Store actions, legal review, anything requiring credentials
  only Liam holds. Do not attempt or simulate these; produce a precise list
  of what Liam must do, then stop.

## Step 1 - gather context before planning

Read, in this order, whatever the task touches. Never plan from memory of
what the repo "probably" contains; open the files.

1. Root CLAUDE.md gotchas and the playbook above.
2. docs/DESIGN.md sections relevant to the task (architecture truth).
3. docs/ROADMAP.md current week (is this on the critical path? gate green?).
4. The per-package CLAUDE.md of every workspace to be touched.
5. The actual contract code: packages/shared for shapes, supabase/migrations
   for the data model and RLS.

## Step 2 - plan before code

Write the plan down before any edit:

- Files and workspaces touched; split along workspace boundaries (pipeline /
  web / app / shared) when large; they rarely conflict.
- Contracts involved, with the exact JSON shape pasted into the plan.
- Migration numbers reserved, one per agent (two agents both creating 0006
  is the predictable collision).
- Tests that will ship with the change, including failure paths.
- Security checklist items the change triggers.
- Any DESIGN.md decision this changes: then DESIGN.md changes in the same
  commit series, and forms-architect sanity-checks the plan first.

Schema or CAD-descriptor changes are lockstep both-sides changes: plan the
TS and Python sides together before touching either.

## Step 3 - delegate to subagents

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
5. The exact verification commands that must pass (table in step 5, also in the root CLAUDE.md).
6. What to return: change summary, verbatim test output, open questions.
   Changes stay uncommitted; the orchestrator commits.
7. What NOT to do: no schema changes, no new dependencies unless named, no
   migration numbers other than the reserved one, no scope creep "while I
   was in there".

UI work goes to (or gets reviewed by) forms-designer before shipping.

## Step 4 - review what comes back (adversarial, in order)

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

## Step 5 - verify and commit (the definition of green)

| Scope | Commands (from repo root) |
|---|---|
| All JS/TS | `pnpm turbo run build typecheck test` then `pnpm format:check` |
| One JS package | `pnpm --filter @forms/shared build`, `... typecheck`, `... test` (same pattern for `@forms/app`, `@forms/web`; app has no build script) |
| Pipeline | `cd services/pipeline && .venv/bin/ruff check . && .venv/bin/pytest` |
| Everything | `make lint typecheck test` |

CI (.github/workflows/ci.yml) runs the same steps; local green must mean CI
green. The orchestrator commits per logical scope with Conventional Commits
and pushes to develop. Report failures verbatim; never claim green without
running. If the change altered a decision or the sequencing, DESIGN.md or
ROADMAP.md changes ride the same commit series.
