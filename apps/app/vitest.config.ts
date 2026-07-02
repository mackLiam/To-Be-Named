import { defineConfig } from 'vitest/config';

// Pure-TS logic tests only (capture gating, token sanity, api stub shapes).
// No React Native component rendering here: jest-expo pulls in a much larger
// native-mocking setup than this Phase 0/1 skeleton needs. Screens get a
// visual/manual check via `expo start --dev-client`; this suite protects the
// logic that is cheap and valuable to unit test.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
