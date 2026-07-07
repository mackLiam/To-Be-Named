# apps/web - Next.js context (marketing + admin)

Next.js on Vercel serves exactly two things: zells.com marketing pages and the
internal /admin panel. The product web app is NOT here; it is the Expo web
build at app.zells.com. If a feature is customer-facing product UI, it belongs
in apps/app.

## Why this app exists at all

Two capabilities Expo web is worst at: SEO-rendered marketing pages, and
server-held secrets. The admin panel needs the Supabase service role key,
which must never reach any browser. So: server components and route handlers
own all privileged access; client components receive only rendered data.

## Structural rule: logic layer first, UI second

All behavior lives in src/lib as small pure functions with Vitest coverage
(access.ts, data.ts, pagination.ts, stl.ts, admin-auth.ts, env.ts, fake.ts).
Pages and route handlers are thin composition over that layer and are allowed
to stay untested precisely because they contain no logic. When adding admin
features: write the lib function and its tests, then the page. If a page
starts growing conditionals, extract them down into lib.

## Privilege model (read before touching /admin)

- Two Supabase clients exist and must never blur: supabase-server.ts (user
  session, RLS-scoped, for anything acting as the viewer) and
  supabase-admin.ts (service role, RLS-bypassing, server-only, for admin reads
  across users and signed-URL generation).
- Every /admin page and route handler checks admin authorization server-side
  via admin-auth.ts before doing anything. A client-side check is decoration,
  not security; the server-side check is the security.
- Signed URLs for meshes/STLs are short-lived and generated at click time.
  Never render a long-lived URL into HTML.
- Every privileged action (STL download, any mutation) writes an audit_log
  row. Body-scan data of likely minors: access must be attributable.
- Fake-data fallback (fake.ts) keeps every page renderable with no env vars.
  Preserve it on new pages; it is how the panel is developed and CI-built
  without a hosted project.

## Design notes

Admin is an internal tool: dense tables, fast scanning, no decoration. Still
Zells-branded (navy/orange accents, Outfit headings, Manrope body), still no
emojis and no em/en dashes. Marketing pages follow the brand fully and get
zells-designer review before shipping. Avoid the generic AI-dashboard look:
no gradient stat cards, no icon noise, tables with real information density.
