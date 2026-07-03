import { defineConfig } from 'vitest/config';

// Pure-TypeScript logic tests only: the admin auth/role decision, the
// fake-data fallback selection, pagination helpers, and the break-glass STL
// route handler (with a mocked Supabase client). No React rendering here;
// server components and pages get a manual check via `next dev`. Test files
// deliberately import only the framework-free modules under src/lib so this
// suite runs clean in a plain node environment with zero backend configured.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
