# apps/web — marketing site + admin panel

Next.js (TypeScript) on Vercel.

- `zells.com`: marketing / SEO pages.
- `/admin`: internal panel — order queue, pipeline job status, failed-scan triage,
  break-glass STL download. Server-side only; uses the Supabase service role via
  server components / route handlers. Admin secrets never reach the client.

The customer-facing product web app is NOT here — it's the Expo web build from
`apps/app` (see `docs/DESIGN.md` §5).

Not scaffolded yet — `create-next-app` when Phase 1 starts.
