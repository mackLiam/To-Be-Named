# Business gaps: what a money-taking shop still needs

Audit date: 2026-11-11 (branch feat/overnight-2026-11-11). Scope: the repo as it
stands, read against what an online business that charges cards for a physical,
made-to-order product needs. Nothing here is legal, tax or vendor advice, and no
price, rate, policy wording or vendor setting is invented: where a fact is
unknown it is recorded as TODO(liam).


**Update 2026-11-11 (9ccd578):** catalog (rank 7), photos (rank 8), and the
code side of availability (rank 13) and tiers (rank 10) shipped in migrations
0022 and 0023. Products have a display order, an availability state
(available, coming soon, paused; archive stays separate) and the sizing modes
each sells, with checkout selling custom fit only. A product cannot be made
available without a CAD model and a price above zero, and checkout refuses
anything not purchasable server-side. Admins upload ordered photos with
required alt text to a public catalog bucket that cannot be listed. The admin
order page no longer crashes for deleted accounts. Still open: the app Shop
tab must read availability, order and the main image (until then coming-soon
items look buyable in the app, though checkout refuses them), preset value
sets, lead time, EXIF stripping, and the photos themselves.

**Update 2026-11-11 (7b3369f):** refunds and remakes (rank 6), emails (rank
9) and order management (rank 12) moved forward in code. Admin remakes
(0024) are zero-cost paid orders linked by remake_of with a fixed reason,
made from shipped or delivered orders, reusing scans and measurements, one
open remake per order, CAD jobs through the existing paid trigger. Partial
refunds from the admin panel (0025) keep a ledger plus Stripe's cumulative
total from the webhook; remaining = charge minus the larger of the two.
Customer lookup by email, append-only internal notes and a paginated order
timeline (0026). New plain-text emails: refund issued, order cancelled,
remake started, rescan needed (not yet wired to the pipeline). Still open:
the remake versus refund policy, whether a fit remake needs a rescan first,
refunding delivered orders from the panel, HTML email templates, lookup by
name and CSV export. Build order items 3 and 4 are done.
## 1. Summary

The software spine of a shop exists and is well tested: a pending-then-paid order
state machine, server-side pricing, hosted Stripe Checkout, an idempotent webhook,
refund and cancel actions, tracking, shipped and confirmed emails behind a
provider seam, an admin panel with MFA, an audit log, and RLS everywhere. What is
missing is almost entirely the business layer around it: tax and shipping are not
decided or charged, the legal pages are drafts with placeholders, there is no
returns, sizing or FAQ content, no print partner or packing process, no remake
path, no analytics or error reporting wiring, and the catalog is a flat list of
products with a price and a URL for a photo. The launch blockers are tax,
shipping cost, legal text, and the accounts that make payments and email real
(Stripe, a verified email sender, a carrier or print partner). All of those need
Liam. The code-only work (admin catalog depth, remake and customer lookup,
emails, SEO, FAQ and policy scaffolding, analytics wiring) is real but is
secondary until the blockers are decided.

## 2. Ranked gaps

Status is have, partial or missing. Impact is blocker, high, medium or low.
"Closes it" marks code-only (C) or needs Liam (L).

| Rank | Area | Status | Launch impact | Evidence | What closes it |
|---|---|---|---|---|---|
| 1 | Tax | missing | blocker | No `automatic_tax` in `apps/web/src/lib/checkout.ts` `buildSessionParams`; KNOWN-ISSUES "payments go-live checklist" says tax is off | L: tax registration decision, Stripe Tax enablement; C: set `automatic_tax` once decided |
| 2 | Shipping | missing | blocker | `buildSessionParams` has `shipping_address_collection` only, no `shipping_options`; `STRIPE_SHIPPING_COUNTRIES` in `.env.example`; `priceOrder` is price times legs | L: carrier, rates, countries, print partner; C: shipping_options plumbing and country list from env |
| 3 | FAQ and policies | partial | blocker | `apps/web/src/app/privacy/page.tsx` and `terms/page.tsx` carry `[to be completed with legal review]`; terms "Shipping" is one sentence; no returns, sizing or FAQ page; sitemap lists only 4 paths | L: legal text, returns and fit policy; C: FAQ, sizing and returns page scaffolds that render Liam-supplied text |
| 4 | Checkout | partial | blocker | `apps/web/src/app/api/checkout/route.ts`, `lib/checkout.ts`, `lib/stripe-webhook.ts`, migration 0013; no terms consent, no tax, no shipping; no live Stripe account | L: Stripe account, keys, webhook, terms URL; C: consent_collection plumbing, success page web link |
| 5 | Fulfillment | missing | blocker | RUNBOOK "Contacts and escalation" is a TODO for the print partner; no packing slip, label or print-queue view; Onshape to STL exists (`admin/api/stl/[jobId]/route.ts`) but nothing after STL | L: print partner or in-house printer, packaging, carrier; C: print-queue and packing-slip views |
| 6 | Refunds and remakes | partial | high | Refund exists: `lib/refund.ts`, admin `refundOrder` action, `charge.refunded` in 0013; no remake or reprint concept in migrations or admin; partial refunds are Stripe-dashboard only | C: remake action (new order or job linked to the original), partial refund; L: policy on when a remake vs refund applies |
| 7 | Catalog | partial | high | `products` table (0001, 0009: name, slug, base_price_cents, active, description, image_url); admin create, edit, archive in `apps/web/src/app/admin/products/*`, `lib/shop-writes.ts`; no display order, tier, or category columns; app Shop tab lists via `apps/app/src/hooks/useProducts.ts` | C: columns and admin fields for tier and display order; L: what is sold and named |
| 8 | Product photos | partial | high | `products.image_url` is a pasted https URL (0009, `ProductForm.tsx`); no upload, no storage bucket for catalog images, no gallery, none for marketing pages | C: public catalog bucket and upload in admin, multiple images; L: the photos themselves (needs printed guards) |
| 9 | Transactional emails | partial | high | `apps/web/src/lib/email.ts`: Resend client, `orderConfirmedEmail`, `orderShippedEmail`, called from the webhook route and `admin/actions.ts`; plain text only; `RESEND_API_KEY` and `EMAIL_FROM` unset | L: Resend account, verified sender domain; C: refund, cancel, remake and rescan-needed emails, HTML template |
| 10 | Pricing and tiers | partial | high | `priceOrder` in `lib/checkout.ts` (base price times legs, one function); DESIGN.md 7a.1 plans Pro, Club, Junior Max; price per product editable in admin; no tier concept in schema | L: the actual prices and tier names; C: tier field, per-tier availability, preset SKUs later |
| 11 | Support and contact | partial | high | `apps/web/src/app/support/page.tsx` plus `SUPPORT_EMAIL` in packages/shared; mailbox must exist (KNOWN-ISSUES); no contact form, no ticket tracking, no help link inside the app | L: create and staff the support mailbox, response-time promise; C: contact form with order reference, support link in app and emails |
| 12 | Order management | partial | medium | `lib/shop.ts` `ORDER_TRANSITIONS`, admin `orders/page.tsx` (status filter, reference lookup), `orders/[id]/page.tsx`, tracking in 0009, `attention.ts` flags; no search by customer email or name, no notes, no bulk views | C: customer lookup, internal notes, order timeline; already planned next |
| 13 | Stock and availability | partial | medium | No stock count by design (0009 header: printed to order); `products.active` is the only switch; no capacity or lead-time setting, no "estimated ship date" shown | C: availability states (open, paused, sold out), lead-time field; L: real lead time from the print partner |
| 14 | Operations runbook | partial | medium | `docs/RUNBOOK.md` covers dead letters, Onshape, bad meshes, Stripe and retention; Supabase incidents and contacts are TODOs; KNOWN-ISSUES: retention, purge and account-deletion sweeps are unscheduled | C: runbook sections for support, remakes, refunds policy once decided, scheduled sweep config; L: hosting accounts and on-call contacts |
| 15 | Admin roles and permissions | partial | medium | `lib/access.ts`, `lib/admin-auth.ts`, `ADMIN_ALLOWLIST` env (email allowlist, MFA aal2 required), audit log at `admin/audit`; every allowed admin can do everything including refunds | C: role column or allowlist tiers (viewer, fulfillment, owner), refund gated to owner; needed only once there is a second person |
| 16 | Analytics | missing | medium | `EXPO_PUBLIC_POSTHOG_KEY` and `SENTRY_DSN` exist in `.env.example` but no posthog or sentry dependency in any package.json and no references in apps/app or apps/web source; DESIGN and ROADMAP plan gate-failure events | C: thin analytics seam with a no-op default, funnel events; L: PostHog and Sentry accounts and keys, consent decision |
| 17 | SEO | partial | medium | `app/robots.ts` and `app/sitemap.ts` exist; `layout.tsx` has title, description, openGraph without an image; no per-page canonical, no structured data, no favicon or OG image asset, no product pages to index | C: OG image slot, canonical, JSON-LD once product pages exist, sitemap from catalog; L: domain live and verified in Search Console |
| 18 | Discounts and promo codes | missing | low | No `promotion`, `coupon` or `discount` anywhere in apps, migrations or checkout params; no `allow_promotion_codes` | C: pass `allow_promotion_codes` (Stripe-side codes) or own table; L: whether to offer any, and their terms |
| 19 | Reviews | missing | low | No review or rating table, UI or schema.org markup | C: post-delivery review request and display, moderation; L: decision to show reviews, and real ones only. Not before first deliveries |
| 20 | Accounts | have | low | `docs/ACCOUNTS.md`; migrations 0011, 0012, 0017 (guest transfer, deletion requests, MFA, client write lockdown); app sign-in; one open code item: admin order page crashes when `orders.user_id` is null | C: fix the null-user admin crash; L: Supabase dashboard setup, SMTP, CAPTCHA (ACCOUNTS.md open items) |

## 3. Per area

### Tax (rank 1)
Stripe Tax is not enabled in the Checkout params and the product has no tax code.
Whether and where FORMS must collect sales tax depends on entity, location and
volume, none of which is in the repo. Docs say Stripe handles tax "by default"
(DESIGN.md section 4 payments row), but the code does not turn it on.
TODO(liam): decide tax registration and enable Stripe Tax. Code-only follow-up:
set `automatic_tax: { enabled: true }` and a product tax code behind an env flag
so it cannot be on without the dashboard being configured.

### Shipping (rank 2)
Checkout collects an address for the countries in `STRIPE_SHIPPING_COUNTRIES`
(default US) and stores it on the order, but charges no shipping and offers no
options. The customer pays the guard price only. Terms say "We ship to the
countries offered at checkout." Nothing says how long a guard takes. TODO(liam):
carrier, rate model (flat, free over a threshold, by weight), countries,
handling time. Code can add `shipping_options` fed by env once a model is chosen.

### FAQ and policies (rank 3)
Privacy and terms are drafts with explicit placeholders for entity, liability,
governing law and record retention (KNOWN-ISSUES, lawyer review is roadmap week
14). The terms cover cancellation until production starts and a case-by-case
fit remedy, but there is no stated returns window, no remake-versus-refund rule,
no sizing guide, and no FAQ. The site has `/support`, `/privacy`, `/terms` only.
TODO(liam): returns and fit policy, final legal text, parental-consent position
for under-16 users (ACCOUNTS.md item 6). Code-only: FAQ, Sizing and Returns page
shells and sitemap entries that render supplied copy, with every unknown shown as
a visible placeholder like the existing legal pages.

### Checkout (rank 4)
Built and tested: `POST /api/checkout` validates body size and origin, prices on
the server, caps open orders, creates a 30 minute hosted session; the webhook
verifies signatures and applies events once through RPCs (0013). Gaps: no terms
acceptance (`consent_collection` needs a terms URL in the Stripe dashboard), no
tax, no shipping, no promo codes, cards only (a deliberate choice), the success
page deep-links `zells://orders` which only helps native payers (KNOWN-ISSUES).
Nothing has run against a live or test Stripe account in production.
TODO(liam): create Stripe account, set keys and webhook, set terms URL, turn on
receipts.

### Fulfillment (rank 5)
The pipeline ends at an STL the admin can download. After that there is no
defined process: who prints, how it is finished, packaged, labelled, and how the
order moves from `in_production` to `shipped` beyond an admin button. The print
partner contact is a RUNBOOK TODO and DESIGN.md plans a partner at roadmap week
19. TODO(liam): print partner or printer, material, finishing, packaging, carrier
account. Code-only: a print queue view (paid orders with ready STL), packing slip
page, and a "needs rescan" order state if print validation rejects a part.

### Refunds and remakes (rank 6)
Refund is implemented and idempotent (`lib/refund.ts`, admin action,
`charge.refunded` stamps `refunded_at`; refunds on unshipped orders cancel them).
Partial refunds happen in the Stripe dashboard and are only audit-logged. There
is no remake: no way to create a second printing for the same order from the
admin, link it to the original, or record why. For a custom-fit product with an
accuracy risk this is the most likely support action. TODO(liam): policy on remake
first versus refund, who pays return shipping, time window. Code-only: a remake
action that enqueues a new CAD job for the same scans with a reason, and a
partial-refund form that calls Stripe and logs it.

### Catalog (rank 7)
Products have name, slug, price, currency, active, description and one image URL.
Admin can create, edit and archive them. Missing: display order, tier or
category, multiple images, size preset SKUs (DESIGN.md 7a.3 plans them),
per-product CAD model status visible in the form (a product with no `cad_model`
makes the paid trigger refuse, per the RUNBOOK). The app Shop tab reads active
products only. The admin product management scope noted as planned next covers
create, edit, archive, availability, price, tiers, display order and photos.
TODO(liam): which products launch and their names (DESIGN.md lists Pro, Club,
Junior Max as working names; ROADMAP says only Club is Phase 0 to 2).

### Product photos (rank 8)
Only a pasted https URL exists. There is no upload path, no catalog storage
bucket, no multi-image support, and the pipeline's own previews (fit preview in
`apps/app/src/components/FitPreview.tsx`) are not stored as images. Real photos
need a printed guard. TODO(liam): photography or renders. Code-only: public
bucket policy and admin upload with size and type caps, ordered gallery, alt text
field.

### Transactional emails (rank 9)
Two emails exist (confirmed, shipped), plain text, sent best effort so a mail
outage never fails an order. Not sent: refund issued, order cancelled, scan
needs redo (measurement gate failure), remake started, delivery follow-up, and
dead-order notices. Supabase auth mail is separate and needs custom SMTP
(ACCOUNTS.md item 2). Stripe can send its own receipts once enabled.
TODO(liam): Resend account, verified sender domain with SPF, DKIM, DMARC.

### Pricing and tiers (rank 10)
Pricing is one function, base price times number of legs, from `products`
rows, so changing a price is an admin edit. There is no tier concept in the
schema, no sale price or compare-at price, no pair discount, and no currency
handling beyond a per-product currency column with checkout in that currency.
Prices themselves are not in the repo and must not be invented.
TODO(liam): launch prices, tier names, whether a pair is discounted.

### Support and contact (rank 11)
A support page and a `SUPPORT_EMAIL` constant exist; emails say replies reach
support. There is no form, no order-reference prefill, no support link in the
app, and no process or response promise. TODO(liam): the mailbox, who reads it.

### Order management (rank 12)
Statuses (pending_payment, paid, in_production, shipped, delivered, cancelled)
with a checked transition table; admin list filters by status and by the
8-character reference; detail page shows address, tracking, audit history and
refund state; tracking is required to ship. Missing: lookup by customer email or
name, internal notes, a per-customer view, CSV export, and handling for deleted
accounts (null `user_id` crash, ACCOUNTS.md). Planned next.

### Stock and availability (rank 13)
By design there is no inventory, only `products.active`. A real shop still needs
a way to pause new orders when the print queue is long, and to tell customers a
lead time. Neither exists. TODO(liam): real lead time and capacity once a
printing process is chosen.

### Operations runbook (rank 14)
Good coverage of the technical failure modes. Missing: customer-facing
procedures (remake, refund policy, lost parcel, dispute handling beyond "answer
in Stripe"), backup and restore, key rotation, the contacts section, and the
scheduler for the three sweeps (until they run, raw scans outlive the 30 days the
privacy text states, a compliance gap in itself).

### Admin roles and permissions (rank 15)
Access is an email allowlist plus confirmed email plus TOTP at aal2, non-staff
get a 404. Every admin has every power, including refunds, product edits, job
retry and STL download of a minor's guard. Fine for one owner. Add roles before a
second person is given access.

### Analytics (rank 16)
Env vars are templated but nothing is wired. Wanted: checkout funnel, scan
completion and gate-failure reasons, order-to-ship time. The data is
children's body data, so consent and what is sent need a decision before any
SDK ships. TODO(liam): accounts, keys, consent and privacy-text position.

### SEO (rank 17)
Robots disallows admin, login, api and checkout; sitemap has four static URLs;
title, description and openGraph exist without an image. There are no product
pages, so nothing sellable is indexable. The app's web build is separate.
TODO(liam): final domain and Search Console verification (domain naming is
currently zells.com by deliberate choice).

### Discounts and promo codes (rank 18)
None. Not needed for launch. If wanted, Stripe-side promotion codes are the
cheapest path. TODO(liam): whether to offer any.

### Reviews (rank 19)
None, and there are no delivered orders to review yet. Never seed fake reviews.

### Accounts (rank 20)
Done to a high standard: guest scans, merge on sign-in, owner deletion, account
deletion with a payment race guard, export, MFA for admin, client write lockdown.
Remaining items are dashboard and SMTP setup by Liam and one admin crash fix.

## 4. Gap classification

### Code-only (buildable without accounts, money or legal text)

1. Fix admin order page crash for an order with null `user_id`.
2. Admin catalog depth: tier, display order, availability states, lead-time
   field, product readiness check (has a `cad_model`).
3. Product photo upload to a public catalog bucket, ordered gallery, alt text.
4. Remake action and partial-refund form with audit logging.
5. Customer lookup (by email, name, reference), order notes, order timeline.
6. Print queue and packing slip admin views.
7. More emails (refund, cancel, rescan needed, remake) and an HTML template, all
   behind the existing no-throw provider seam.
8. FAQ, Sizing and Returns page shells with visible placeholders, sitemap
   entries, per-page metadata and canonical, OG image slot.
9. Support contact form carrying an order reference; support link in app.
10. Env-gated plumbing in checkout: `automatic_tax`, `shipping_options`,
    `consent_collection`, `allow_promotion_codes`, each off until configured.
11. Admin roles (viewer, fulfillment, owner) and refund gated to owner.
12. Analytics and error-reporting seam with a no-op default and funnel events.
13. Runbook sections for remake, refund, lost parcel, dispute, and sweep
    scheduling config.

### TODO(liam) (needs an account, money, or legal text; never invent)

- TODO(liam): Stripe account, live keys, webhook endpoint, receipts, terms URL.
- TODO(liam): tax registration decision and Stripe Tax enablement.
- TODO(liam): shipping carrier, rate model, countries, handling time.
- TODO(liam): print partner or in-house printing, materials, finishing,
  packaging, lead time, capacity.
- TODO(liam): launch prices, tier names, pair pricing, which products launch.
- TODO(liam): final privacy and terms text, returns and fit policy, record
  retention after deletion, parental consent under 16, entity and governing law.
- TODO(liam): remake versus refund policy and return shipping responsibility.
- TODO(liam): Resend account and verified sender domain; Supabase custom SMTP
  with SPF, DKIM, DMARC.
- TODO(liam): support mailbox existing and staffed, response-time promise.
- TODO(liam): PostHog and Sentry accounts, keys, consent position.
- TODO(liam): product photography or renders (needs printed guards).
- TODO(liam): domain live, Search Console, hosted Supabase and web deploy,
  scheduler for the retention and deletion sweeps.
- TODO(liam): whether to offer promo codes and reviews at all.
- TODO(liam): CAPTCHA or attestation decision (ACCOUNTS.md item 5).

## 5. Recommended build order (code-only)

Admin product management, order status, tracking, refunds and remakes, and
customer lookup in apps/web are already planned next. Note that product
create, edit, archive, order status, tracking and full refund already exist in
code, so the planned work is the missing depth below, in this order:

1. Fix the null-user admin order crash (small, removes a known crash before the
   deletion worker is armed).
2. Admin catalog depth: tier, display order, availability states, lead time, and
   a readiness check so a product cannot go active without a `cad_model`.
3. Remake action, partial refund, and the extra emails that go with them
   (refund, cancel, remake). These are the support actions most likely to occur.
4. Customer lookup, order notes and timeline.
5. Product photo upload and gallery.
6. Env-gated checkout plumbing (tax, shipping options, consent, promo codes) so
   the day Liam decides, it is a config change plus a test, not a build.
7. FAQ, Sizing and Returns shells, metadata, sitemap, OG image slot, support
   form.
8. Print queue and packing slip views (shape finalised once the print partner is
   known).
9. Admin roles.
10. Analytics and error-reporting seam, after the consent decision.
11. Runbook additions, written as each feature above lands.

Every step ships with its tests and security pass per CLAUDE.md. Update
DESIGN.md in the change that alters a decision (for example the order state
machine if a remake status is added), and move closed items in KNOWN-ISSUES.md.
