# apps/app - Zells product app

Expo Router **universal app**: one codebase shipping as the iOS app, the Android app,
and the product web app (`app.zells.com`). See `docs/DESIGN.md` sections 3, 5, and 6
for the full platform strategy; this file is the practical dev-flow reference.

## Dev flow

```
pnpm install                        # from the repo root
pnpm --filter @zells/app dev        # expo start --dev-client
```

Then open the app in your EAS dev-client build (see below), not Expo Go.

## Why this cannot run in Expo Go

The capture flow wraps Apple's `ObjectCaptureSession` / `PhotogrammetrySession` in a
Swift native module. Native modules only load in a custom dev client, never in Expo
Go, which ships a fixed set of modules Apple/Expo control. That is CLAUDE.md gotcha 3
and docs/DESIGN.md section 5: you need `expo-dev-client` and an EAS build to test
capture on a physical device, full stop.

Every other tab (Scan library, Shop, Orders, Profile) has no native-module
dependency and would technically run in Expo Go, but the project standardizes on the
dev client everywhere so there is one supported way to run the app, not two.

## EAS dev client

The capture native module does not exist yet (Phase 0, see docs/DESIGN.md section
11). Once it does:

```
eas build --profile development --platform ios
```

installs a dev client onto a physical LiDAR iPhone (iPhone 12 Pro or later Pro
model, iOS 17+). Until then, `pnpm --filter @zells/app dev` plus Expo's iOS
Simulator or Android emulator is enough to work on every screen except the actual
capture flow, which is gated off on non-capable devices anyway
(`src/lib/capture.ts`).

## Capture module

The guided scan lives in a **local Expo module** at `modules/zells-capture/`. It wraps
Apple's `ObjectCaptureSession` (guided photo capture) and `PhotogrammetrySession`
(on-device reconstruction), then converts the resulting USDZ to OBJ with ModelIO so the
Python pipeline can consume it (CLAUDE.md gotcha 4). All files stay inside the app
sandbox; the module adds no network or analytics calls (CLAUDE.md gotcha 5).

Layout:

```
modules/zells-capture/
  expo-module.config.json   Autolinking manifest (apple platform)
  ZellsCapture.podspec       CocoaPods spec, iOS 17 minimum
  package.json               Local module metadata (not a pnpm workspace package)
  index.ts                   Public JS API (safe on every platform)
  src/
    types.ts                 Shared TS types (mirror the Swift Records/Events)
    errors.ts                CaptureError + typed codes + mapNativeError
    native.ts                requireOptionalNativeModule boundary (null when absent)
    *.test.ts                Vitest: fallback + error mapping (no device needed)
  ios/
    ZellsCaptureModule.swift        Module definition (functions + events)
    CaptureSessionController.swift   ObjectCaptureSession + SwiftUI hosting
    ReconstructionController.swift   PhotogrammetrySession + USDZ->OBJ export
    Records.swift                    Expo Record types
    ZellsCaptureError.swift          Typed Swift exceptions -> JS error codes
```

JS entry points (see `src/lib/nativeCapture.ts` for the app-facing seam):

- `isSupported()` - `ObjectCaptureSession.isSupported` (LiDAR + iOS 17). The LiDAR
  truth source. Resolves `false` wherever the native module is absent.
- `startCapture()`, `reconstruct(options)`, `cancel()` - reject with a typed
  `CaptureUnavailableError` when the module is absent (web, Android, Simulator, Expo Go),
  so nothing crashes off-device.
- `addCaptureStateListener`, `addReconstructionProgressListener` - event subscriptions.

The Swift compiles only inside an EAS dev-client build (there is no Swift toolchain in
CI or this scaffold). The TypeScript wrapper is fully unit-tested with the native module
mocked, so `pnpm --filter @zells/app test` covers the JS logic without a device.

### Building the dev client (to run capture on-device)

```
eas build --profile development --platform ios   # see eas.json
```

Install the resulting dev client on a physical LiDAR iPhone (12 Pro or later Pro, iOS
17+). The iOS Simulator has no LiDAR, so `isSupported()` is `false` there; use it only
for the non-capture screens.

### Unverified (on-device debugging TODO)

The Swift was written without a compiler and is flagged throughout with searchable
`UNVERIFIED:` comments. Grep before the first device session:

```
grep -rn "UNVERIFIED:" modules/zells-capture
```

Highest-risk items: exact `ObjectCaptureSession` / `PhotogrammetrySession` state and
output enum cases, presenting the SwiftUI `ObjectCaptureView` from the RN view
hierarchy, ModelIO USDZ->OBJ export fidelity, and whether Expo surfaces the Swift
exception `code` strings unchanged (the JS `mapNativeError` has a keyword fallback if
not).

## Environment variables

Copy the repo-root `.env.example` to `.env` and fill in:

- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_ANON_KEY`

Only `EXPO_PUBLIC_*` variables ever reach this app; anything without that prefix
never ships in the bundle (see CLAUDE.md gotcha 5). With no `.env` at all, the app
still runs: the data layer (`src/lib/api.ts`) falls back to empty lists instead of
querying Supabase, so a fresh clone with zero backend configured boots straight into
the empty states.

## Structure

```
app/                Expo Router routes (file-based)
  _layout.tsx        Root layout: font loading, splash hold, stack shell
  (tabs)/            Scan, Library, Shop, Orders, Profile
  capture-info.tsx   Capture entry-point stub (modal)
src/
  theme/             Design tokens (colors, radius, spacing, type) + contrast checks
  lib/               capture.ts (platform gating), api.ts (data stubs), supabase.ts
  hooks/              Typed hooks wrapping the data layer for screens
  components/         Shared UI primitives (Screen, Heading, Body, Button, Rule)
```

## Scripts

- `pnpm --filter @zells/app dev` - `expo start --dev-client`
- `pnpm --filter @zells/app typecheck` - `tsc --noEmit`
- `pnpm --filter @zells/app test` - `vitest run` (pure-logic tests only; see below)

## Testing approach (deviation from the original jest-expo plan)

This skeleton uses **vitest**, not jest-expo + @testing-library/react-native, for
the current test surface: capture gating, design-token sanity (contrast ratios,
radius, spacing, type scale), and data-layer stub shapes. All of that is pure
TypeScript with no React Native rendering involved, and vitest already runs the
same way in `packages/shared`, so the monorepo has one test runner story instead of
two. jest-expo is worth adding later once there are actual components worth
render-testing (e.g. snapshot or interaction tests on `Button`, `Screen`); it was not
installed now because it would add native-mock setup this phase does not need yet.
