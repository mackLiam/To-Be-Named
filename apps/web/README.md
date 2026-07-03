# apps/web - marketing site + admin panel

Next.js (TypeScript) on Vercel.

- `zells.com`: marketing / SEO pages.
- `/admin`: internal panel - order queue, pipeline job status, failed-scan triage,
  break-glass STL download. Server-side only; uses the Supabase service role via
  server components / route handlers. Admin secrets never reach the client.

The customer-facing product web app is NOT here - it's the Expo web build from
`apps/app` (see `docs/DESIGN.md` §5).

## Status

- Landing page: done (static, self-hosted fonts via next/font, no client JS beyond React).
- Admin logic layer (`src/lib`): done and unit tested - access decisions, bounded
  data queries, pagination, break-glass STL download with mandatory audit write,
  env gating with a hard "no NEXT_PUBLIC secrets" assertion.
- Admin pages/routes (`src/app/admin/...`): not built yet; they are thin adapters
  over the lib layer above.

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
