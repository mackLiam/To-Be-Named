# apps/app — Zells product app

Expo Router **universal app**: one codebase shipping as the iOS app, the Android app,
and the product web app (`app.zells.com`).

- Screens: Home, Scan, Shop, Orders, Profile (white/orange/navy, Outfit + Manrope).
- Capture: Swift native module (config plugin) wrapping ObjectCaptureSession /
  PhotogrammetrySession — iOS 17+ with LiDAR only; gated off elsewhere.
- **Requires a custom dev client (EAS build). Does not work in Expo Go** — the native
  capture module cannot load there.
- Client-safe env vars only (`EXPO_PUBLIC_*`). Talks to Supabase directly (RLS-scoped);
  never to the pipeline worker.

Not scaffolded yet — `create-expo-app` with Expo Router when Phase 1 starts
(see `docs/DESIGN.md` §11).
