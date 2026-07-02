# Zells

Custom 3D printed soccer shin guards, fitted to your leg from a simple phone scan.
No sizing charts, no generic fits — just a scan, and a shin guard made for your exact leg.

**How it works:** scan your leg with your iPhone → the app extracts 25 exact
measurements from the 3D reconstruction → those drive a parametric CAD model that
generates a print-ready STL → printed and shipped. Fully automated; no human touches
a CAD file per customer.

## Repo layout

| Path | What |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | **Design doc — source of truth** (architecture, stack, security, roadmap) |
| [`apps/app/`](apps/app/) | Expo universal product app (iOS + Android + web) |
| [`apps/web/`](apps/web/) | Next.js marketing site + internal admin panel |
| [`services/pipeline/`](services/pipeline/) | Python worker: mesh → measurements → Onshape → STL |
| [`packages/shared/`](packages/shared/) | Shared contracts: measurement schema, TS types, design tokens |
| [`CLAUDE.md`](CLAUDE.md) | Working context + gotchas for AI-assisted development |

## Getting started

```sh
cp .env.example .env   # then fill in real keys — .env is gitignored
```

App scaffolding lands in Phase 1; current phase is **Phase 0 — prove the
scan→measurement→CAD→print pipeline end-to-end** (see `docs/DESIGN.md` §11).

## Status

- Done: design doc
- Done: measurement extraction validated on synthetic mesh
- Next: first real scan (needs LiDAR iPhone + EAS dev build)
- Next: freeze 25-variable schema with CAD collaborator
- Next: Onshape API round-trip, first zero-touch printed guard
