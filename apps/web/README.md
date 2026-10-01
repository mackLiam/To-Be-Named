# apps/web - marketing site + admin panel

Next.js (TypeScript) on Vercel.

- `zells.com`: marketing / SEO pages.
- `/admin`: internal panel. Server-side only; uses the Supabase service role via
  server components / server actions. Admin secrets never reach the client.
  - `/admin/orders`: orders by status; the order page moves status (mark paid
    manually, start production, ship, deliver, cancel), edits tracking, and
    shows customer, address, pipeline jobs and audit history.
  - `/admin/products`: the catalog the app Shop tab sells. Create/edit name,
    slug, price, description, image URL, availability, CAD descriptor.
  - `/admin`: pipeline queue, failed-scan triage, break-glass STL download.
- `/login`: staff sign-in (email + password).

The customer-facing product web app is NOT here - it's the Expo web build from
`apps/app` (see `docs/DESIGN.md` §5).

## Status

- Landing page: done.
- Admin: done for orders, products and the pipeline queue. Every write
  re-checks admin server-side and writes an `audit_log` row; order moves follow
  `ORDER_TRANSITIONS` in `src/lib/shop.ts` (shipping requires tracking).
- Not built yet: Stripe refunds (cancel reminds you to refund in Stripe),
  customer emails on status change, image upload (paste an https URL).

## Running the live panel

1. Apply migrations through `0009_shop_admin.sql`.
2. Set `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` (server-side only) and `ADMIN_ALLOWLIST`.
3. Create the admin user with a password in the Supabase dashboard
   (Authentication > Users), then sign in at `/login`.

## Admin access

Two mechanisms, checked in order (see `src/lib/access.ts`):

1. `profiles.role === 'admin'` - the long-term mechanism. The column does not
   exist in the schema yet; a migration must add it.
2. `ADMIN_ALLOWLIST` - comma-separated emails in the environment (bootstrap
   mechanism that works today). See `.env.example`.

Non-admins always get a 404, never a login wall that reveals the panel exists.

## Fake mode

With no Supabase env configured, admin data helpers return clearly-fake
placeholder data and never attempt a network call, so the app runs with zero
backend (mirrors `apps/app`).
