# Zells

Custom-fit, 3D-printed soccer shin guards: phone scan → measurement extraction →
parametric CAD → print-ready STL, fully automated, no manual CAD per customer.

## Repo structure

| Path | What |
|---|---|
| `apps/app/` | Expo Router universal app (iOS + Android + web, `app.zells.com`) |
| `apps/web/` | Next.js marketing site (`zells.com`) + internal admin panel |
| `services/pipeline/` | Python worker: mesh → measurements → Onshape → STL |
| `packages/shared/` | Shared TS types + the frozen 25-variable measurement JSON Schema |
| `supabase/` | Postgres migrations, RLS policies, storage config |
| `docs/DESIGN.md` | Architecture, rationale, roadmap - **source of truth** |
| `CLAUDE.md` | Working conventions and gotchas for AI-assisted development |

## Requirements

- Node 22 (see `.nvmrc`), pnpm 9.15.0 (via corepack, see `packageManager` in `package.json`)
- Python 3.12 (see `.python-version`)
- Supabase CLI + Docker, only for `make db-reset` (local Postgres stack)

## Quickstart

```sh
make bootstrap   # corepack + pnpm install, pipeline venv, seeds .env from .env.example
make test        # test-js + test-py
make dev-app     # Expo app dev server
make dev-web     # Next.js dev server
make dev-pipeline # pipeline worker (FastAPI, autoreload)
```

Run `make help` for the full target list (lint, format, typecheck, db-reset, clean).

## Environment setup

`make bootstrap` copies `.env.example` to `.env` if one doesn't already exist (it never
overwrites an existing `.env`). Fill in real values before running anything that talks
to a live service:

- **Supabase** (`SUPABASE_*` / `*_SUPABASE_*`): project URL + anon key are from the
  Supabase dashboard (client-safe, protected by RLS); the service role key is
  server-only, used by the pipeline worker and admin routes.
- **Onshape** (`ONSHAPE_*`): API keys from a company Onshape account
  (dev-portal.onshape.com), plus the document/workspace/element ids for the
  parametric shin guard model. Pipeline-worker only, never client-side.
- **Stripe** (`STRIPE_*`): publishable key is client-safe; secret and webhook secret
  are server-only.
- **Sentry / PostHog**: DSN and project keys from their respective dashboards.

See `.env.example` for the full list and which values are client-safe
(`EXPO_PUBLIC_*` / `NEXT_PUBLIC_*`) versus server-only.

## Conventions

Full conventions live in `CLAUDE.md` (git rules, coding standards, no-emoji/no-dash
writing rules, the 25-variable schema contract, etc.) and `docs/DESIGN.md` (why the
stack looks the way it does). Read both before making architectural changes.

## Current phase

**Phase 0** - prove the pipeline end-to-end: real scan → extraction → Onshape →
printed guard with zero manual CAD (see `docs/DESIGN.md` §11). Auth and payments are
deliberately deferred until this works. Open blocker: confirming the 25 variable
names with the CAD collaborator.
