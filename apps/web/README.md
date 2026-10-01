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

See `src/lib/access.ts`. All of these must hold, checked server-side on every
admin page, server action and route handler:

1. The email is in `ADMIN_ALLOWLIST` (comma-separated, server-side env; see
   `.env.example`). This is the only authorization source. It is deliberately
   not a database column: users can write their own `profiles` row, so a role
   stored there would be self-grantable.
2. The email is confirmed (`email_confirmed_at` set).
3. The session is at AAL2: the user signed in with a password at `/login`,
   then entered a TOTP code at `/login/mfa`. Staff without a verified
   authenticator are taken through enrollment (QR code or manual key) on
   first sign-in.

Anyone failing 1 or 2 gets a 404, never a login wall that reveals the panel
exists. Requires TOTP MFA enabled in the Supabase project (Authentication >
Multi-Factor). To reset a lost authenticator, delete the user's factor in
the Supabase dashboard; they re-enroll on next sign-in.

Security headers (HSTS, frame denial, nosniff, referrer and permissions
policy, a minimal CSP without `script-src`) are set in `next.config.mjs`;
`/admin` and `/login` are also `no-store` and `noindex`.

## Fake mode

With no Supabase env configured, admin data helpers return clearly-fake
placeholder data and never attempt a network call, so the app runs with zero
backend (mirrors `apps/app`).
