# Overnight brief, 2026-11-11

Unattended session. Liam is asleep until 07:00 and cannot answer questions.
Orchestrate: plan, delegate to subagents, review, verify, commit. The goal
prompt points here; this file is the full instruction set.

## Priority

**The scan comes first.** Liam wants it to work flawlessly from the plan in
docs/SCAN-V3-PLAN.md, including on terrible videos, because that is what real
users will submit. Everything else is for when the scan work is done or
blocked.

## Read first

CLAUDE.md, docs/OPERATING-PROCEDURE.md (follow it for every nontrivial task),
docs/SCAN-V3-PLAN.md, docs/DESIGN.md (7a.2, 12.2), docs/KNOWN-ISSUES.md, and the
per-package CLAUDE.md of whatever you touch.

## Ground rules

- Branch: `git checkout -b feat/overnight-2026-11-11` from develop. Commit there
  per logical scope and push the branch. Do not merge to develop; never touch
  main.
- Run git commands in their own Bash calls (chaining git with a non-git command
  triggers a permission prompt). Never `git add -A` or stash. Never edit
  ~/.claude settings.
- Save usage and context: delegate the big pieces to subagents (Sonnet for
  mechanical work, the strongest model for math, contracts, security and
  capture). Subagents leave changes uncommitted; you review and commit. Run
  parallel subagents only on disjoint workspaces (pipeline / web / app /
  shared), or give them `isolation: "worktree"`.
- Nobody can answer questions. When a decision blocks you, take the plan's
  recommended default, mark it `TODO(liam):` in code or docs, and list it in the
  report. Never invent facts (measurements, prices, legal text, Stripe or email
  settings).
- Onshape: you may make new model copies if that makes the scan or the guard
  better (Liam's standing permission). Copies only, created private and checked,
  deleted at once if they come back public; never edit the original MVP
  document or the pipeline template; never put a real person's measurements in
  any Onshape document. Rules: SCAN-V3-PLAN.md section 6a.1. Do not enable
  automated CAD for real orders.
- Do not install system packages, add AGPL dependencies, send data to any
  external service, or attempt human-only work (prints, device runs, accounts,
  legal review).
- Repo rules: no emojis, no em or en dashes, Conventional Commits, no AI
  attribution, tests ship with every change. Every commit passes the
  verification commands for what it touches (table in CLAUDE.md). If something
  stays red after two honest attempts, revert that piece, note it, move on.
- Context: the 25 stored values are leg measurements (schema 1.1.0); the
  Onshape model's same-named variables are crest-relative guard points made
  only by services/pipeline/src/forms_pipeline/cad/profile.py; its wrap
  fractions are provisional.

## 1. The scan (main work)

Test videos: `services/pipeline/recordings/videos/IMG_3834.MOV` and
`IMG_3836.MOV` (gitignored; moved there from Downloads). They are iPhone Camera
app recordings of adult legs, with consent, and deliberately bad, like real
submissions. They have no ARKit poses, no depth and no tape measurements.
Treat them as body data: never commit them or anything derived from them;
keep derived output under services/pipeline/recordings/ or the scratchpad;
never upload anything.

Build a local video harness with what the Mac already has (no ffmpeg or COLMAP;
do not install them):

- A macOS Swift CLI (extend services/reconstruct or a sibling package) that
  reads frames with AVFoundation and picks sharp keyframes spread over the
  motion; Apple Vision per keyframe for the leg mask
  (VNGenerateForegroundInstanceMaskRequest, person segmentation if better) and
  knee/ankle pose; PhotogrammetrySession reconstruction with camera poses, as
  forms-reconstruct does; output a bundle the pipeline reads.
- A Python driver that runs every video through reconstruction and measuring
  and writes a results table.

Scale is unknown, so report scale-free metrics: success or failure with the
gate reason, OD/OW per slice, slice widths relative to S3, profile shape, mask
quality, and agreement between videos of the same leg.

Then iterate as much as possible: fix real failures in segmentation, keyframe
choice, axis finding, landmarks and gates so bad videos still produce a sane
leg, or fail with a clear, fixable reason. Use the plan's estimator ideas
(section 4) where they help fill gaps, and the sweep spike (Phase 0.5) and
capture UX (sections 5.2 and 5.3) where the fix belongs on the phone. Tests for
every fix (synthetic legs or fixtures, never the videos). Write
docs/VIDEO-HARNESS.md: how to run it and what each video taught (counts and
ratios only). Note in SCAN-V3-PLAN.md section 5.7 that one tape measurement per
leg would add real scale.

If time remains on the scan: Phase 1 estimator (plan sections 4 and 6.2,
forms-architect reviews the brief first, migrations 0018, 0019, 0021), then the
Phase 2 react-three-fiber + expo-gl spike (stop and report if it fails).

## 2. When the scan is done or blocked

- **Admin (apps/web):** manage the shop. Products: create, edit, archive,
  availability, price, tiers sold, display order. Product photos: upload,
  reorder, main image, delete (public bucket is fine; scans stay private). Then
  order status, tracking, refunds and remakes, customer lookup. Server-side
  authz on every route, RLS on every new table, validated uploads, migrations
  from 0022 up, tests.
- **UI and UX pass:** the app does not look like a normal app; make it look and
  work like a finished business someone trusts with money. forms-designer leads
  (consult before, review after): every screen in apps/app, the marketing site
  and admin in apps/web. Consistent layout, real copy, empty/loading/error
  states, accessibility, mobile web, brand tokens from CLAUDE.md.
- **Business gaps:** docs/BUSINESS-GAPS.md: have / partial / missing for
  catalog, photos, stock, pricing and tiers, checkout, tax, shipping, orders,
  fulfillment, refunds and remakes, accounts, emails, support, FAQ and
  policies, SEO, analytics, discounts, reviews, admin roles, runbook; ranked by
  launch impact. Build the top code-only items; anything needing an account,
  money or legal text is a TODO(liam).
- Loose end: apps/app/src/lib/fitPreview.ts says Club covers 0.12 to 0.88; the
  model covers 0.2 to 0.8.

## Report

Keep docs/OVERNIGHT-REPORT-2026-11-11.md updated after every milestone (commit
and push it each time), so a usage cutoff never loses the summary. It covers:
what was done with commit hashes; the video results table (counts and ratios
only); what is untested on a device; every TODO(liam) default; Onshape copies
created; what failed and why; next steps. Finish it before 07:00.
