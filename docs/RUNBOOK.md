# Zells Runbook

Operational playbook for the deployed system (ROADMAP.md week 19 artifact,
scaffolded early; fill each section in with real commands and thresholds as
the infrastructure lands). One section per failure mode, each answering:
how you notice, how you diagnose, how you fix, how you prevent recurrence.

Status: skeleton. Sections marked TODO have no deployed system behind them
yet; write them when the corresponding infrastructure ships (see ROADMAP.md
months 2-5).

## Job dead-letters

- Notice: dead-letter queue notification (week 19 alert), admin panel jobs
  view filtered to failed.
- Diagnose: TODO - job row (step, last error, attempts), worker logs in the
  deploy platform, Sentry event for the job_id.
- Fix: TODO - retry via queue helper after cause fixed; poison meshes get
  the scan failed with a user-facing rescan reason instead of infinite
  retries.
- Prevent: every new failure mode gets a test in services/pipeline before
  the fix ships.

## Onshape rate limits or outage

- Notice: CAD-step failures clustering, per-job latency spiking (latency is
  logged from the first real call, ROADMAP.md week 4).
- Diagnose: TODO - Onshape API status, response headers on 429s.
- Fix: TODO - queue concurrency is deliberately 1-2 against Onshape; jobs
  back off and retry, orders are not lost, just delayed.
- Prevent: latency log feeds the December Onshape-ceiling decision
  (DESIGN.md section 7 exit strategy).

## A mesh fails repeatedly

- Notice: same scan_id failing measure step across retries.
- Diagnose: download via break-glass admin path (audit-logged), run
  zells-extract on it locally, check which gate fails and why.
- Fix: if capture-side: user gets rescan guidance; if extraction-side: fix
  with a regression test and, with consent, add the mesh to the golden
  suite (tests/fixtures, provenance in docs/accuracy-log.md).
- Prevent: gate-failure PostHog events aggregate into guidance copy
  (ROADMAP.md week 13).

## Stripe disputes and webhook failures

- TODO (Month 3): webhook signature failures, replayed/idempotent events,
  dispute evidence flow, refund path.

## Supabase incidents

- TODO (Month 2): RLS regression checklist, storage CORS, backup/restore
  procedure (Supabase Pro, Month 3), key rotation steps.

## Retention sweep

- Notice: sweep run logs (deployed worker scheduled task), audit_log rows.
- Diagnose: sweep is idempotent and batch-limited; a stuck batch means a
  storage API failure on specific objects - check per-item errors in logs.
- Fix: re-run; 404s on already-deleted objects are treated as success.
- Prevent: dry-run flag exists for verifying behavior after changes.

## Contacts and escalation

- TODO: print partner contact + SLA (week 19), Supabase/Fly support links,
  CAD collaborator for model regeneration failures.
