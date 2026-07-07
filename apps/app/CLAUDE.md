# apps/app - Expo universal app context

One Expo Router codebase shipping iOS, Android, and web (app.zells.com).
Read root CLAUDE.md gotchas 3 and 5 first. This file records the reasoning
behind the app's structure so changes preserve it.

## Mental model

The app is a thin view over Supabase plus one genuinely native capability
(iOS capture). Everything that can be server-side is server-side; the app
owns capture, upload, and presentation. If a feature seems to need app-side
computation over a mesh or measurements, it almost certainly belongs in the
pipeline instead: the app never interprets geometry.

## Platform gating (the capture split)

- Capture requires iOS 17+, LiDAR, and the custom dev client. It can never
  work in Expo Go or a simulator. All capture entry points go through the
  `isCaptureSupported()` style gate in src/lib/capture.ts; other platforms get
  the "scan on your iPhone, it appears here" state. Never conditionally import
  the native module at top level of a shared file; web bundles must not touch it.
- modules/zells-capture is the only Swift in the repo. Its TS surface
  (src/types.ts, src/native.ts, src/errors.ts) is typed and unit-tested even
  though the Swift side needs a physical device: keep the boundary such that
  everything except the actual ObjectCaptureSession calls is testable on CI.
- Errors from the native layer are mapped to typed, user-actionable errors in
  src/errors.ts. When adding native surface, extend the error mapping in the
  same change; a raw NSError code reaching the UI is a bug.

## Data layer conventions

- Lazy Supabase client with a fake-data fallback (src/lib/supabase.ts,
  src/lib/api.ts): with no EXPO_PUBLIC_SUPABASE_* env, hooks resolve fake data
  so every screen renders in local dev and CI with zero backend. Preserve this
  on every new data path; a screen that white-screens without credentials
  breaks the development loop for everyone. Fake mode must be visually
  ordinary and code-obvious (one clearly named branch), never sprinkled
  through components.
- Hooks (useScans, useOrders, useProducts, useCaptureFlow) own all data
  access; screens in app/ are layout plus hook calls. Business logic that
  needs testing lives in src/lib as pure functions, tested with Vitest.
  Components stay thin enough that not testing them is acceptable.
- State enums come from @zells/shared (states.ts). String literals for scan or
  job status anywhere in this app are a bug: the SQL state machine is the
  authority and shared enums are its projection.

## Upload path reasoning

Upload is the only place the app writes anything heavy. Constraints that
shaped it: the meshes bucket is private with owner-scoped paths (storage
policies dictate the `${userId}/...` path convention; follow the policy, do
not invent paths), client-side size cap mirrors the pipeline's mesh cap so
users fail fast before burning upload bandwidth, and enqueueing a job goes
through a SECURITY DEFINER RPC that re-checks ownership server-side. The
client's word is never trusted: RLS and the RPC enforce everything the UI
also happens to check.

## UI and design

- Design tokens in src/theme/tokens.ts are the only source of colors, spacing,
  and type (Outfit headings, Manrope body; white/orange/navy). No raw hex
  values in components. Contrast helpers exist in src/theme/contrast.ts; new
  color pairs must pass them.
- Consult the zells-designer agent before new screens. Internal-quality UI is
  not acceptable in this app; it is the product.
- No emojis, no em/en dashes, in code or copy.

## Sensitive-data reflexes specific to this app

Scans are body scans, likely of minors. In the app this means: no mesh or
measurement data in logs or analytics events, no scan thumbnails or files
cached outside the app sandbox, signed URLs are requested at use time and
never persisted, and any new screen showing scan data must come from the
user's own RLS-scoped session (no service keys exist in this codebase, and
nothing but EXPO_PUBLIC_* values ever may appear in it).

## Subagent brief (when you are delegated work here)

- Data access through hooks; logic as pure functions in src/lib with Vitest
  tests; screens stay layout plus hook calls. Preserve the fake-data
  fallback on every new data path (the screen must render with no env vars).
- Never import the native module outside the gated path in src/lib/capture.ts;
  the web bundle must not touch it. Capture-related code cannot be verified
  on a simulator; say so in your return instead of claiming device behavior.
- UI uses tokens from src/theme/tokens.ts only (no raw hex, no ad hoc
  spacing) and will get zells-designer review; build to that bar.
- State enums come from @zells/shared; a string-literal status is a bug.
- Verify before returning (from repo root):
  `pnpm --filter @zells/app typecheck && pnpm --filter @zells/app test && pnpm format:check`
  Return the output verbatim. Leave all changes uncommitted.
