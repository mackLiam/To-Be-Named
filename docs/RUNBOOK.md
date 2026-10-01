# FORMS Runbook

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
  forms-extract on it locally, check which gate fails and why.
- Fix: if capture-side: user gets rescan guidance; if extraction-side: fix
  with a regression test and, with consent, add the mesh to the golden
  suite (tests/fixtures, provenance in docs/accuracy-log.md).
- Prevent: gate-failure PostHog events aggregate into guidance copy
  (ROADMAP.md week 13).

## Stripe payments, webhooks and refunds

How it works: the app calls `POST /api/checkout` (apps/web), which creates
the order as pending_payment and a hosted Checkout Session (30 minute
expiry). Stripe calls `POST /api/stripe/webhook`; each handled event goes
through one RPC in migration 0013 that records the event id and applies the
effect in one transaction (stripe_events), so redelivery is harmless.
Paid orders enqueue CAD through the orders_enqueue_cad trigger.

- Notice: Stripe dashboard > Developers > Webhooks shows failed deliveries
  (Stripe retries for up to 3 days); web host logs show
  `stripe webhook: <rpc> failed: ...`; an order stuck in pending_payment
  after a customer says they paid.
- Diagnose:
  - 400 invalid_signature: STRIPE_WEBHOOK_SECRET does not match the
    endpoint's signing secret (it differs per endpoint and per test/live).
  - 501: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET or the service role is
    missing on the web host.
  - 500 processing_failed on checkout.session.completed: usually the paid
    trigger refusing (a scan with no measurements, or a product with no
    cad_model); the message is in the web logs. Nothing was recorded, so
    the next retry applies cleanly once the cause is fixed.
  - Admin > Audit log, filter orders: every webhook outcome is a
    `stripe.*` row with event id, outcome, expected vs charged amount.
- Fix:
  - Fix the cause, then use "Resend" on the event in the Stripe dashboard;
    a duplicate is a no-op, a previously failed one applies now.
  - An audit row with `needs_refund: true` means a payment landed on an
    order already cancelled (admin cancel or account deletion raced the
    payment). The order shows the payment; use Refund payment on it.
  - Refunds: Admin > order > Refund payment (idempotent per order). It
    cancels the order if it had not shipped; charge.refunded then stamps
    refunded_at. Partial refunds are done in the Stripe dashboard and only
    audit-logged here.
- Disputes: answer in the Stripe dashboard with the order's audit history,
  the shipping address and tracking from the admin order page. No dispute
  automation exists.
- Prevent: never hand-edit order status to paid for a Stripe order; the
  manual "Mark paid" exists only for orders paid outside Stripe.

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
