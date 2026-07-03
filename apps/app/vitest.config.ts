import { defineConfig } from 'vitest/config';

// Pure-TS logic tests only (capture gating, token sanity, api stub shapes).
// No React Native component rendering here: jest-expo pulls in a much larger
// native-mocking setup than this Phase 0/1 skeleton needs. Screens get a
// visual/manual check via `expo start --dev-client`; this suite protects the
// logic that is cheap and valuable to unit test.
export default defineConfig({
  test: {
    // src/** covers app logic; modules/** covers local native modules' JS
    // wrappers (e.g. modules/zells-capture), whose fallback and error-mapping
    // logic is pure TypeScript and worth unit testing without a device.
    include: ['src/**/*.test.ts', 'modules/**/*.test.ts'],
    environment: 'node',
  },
});
