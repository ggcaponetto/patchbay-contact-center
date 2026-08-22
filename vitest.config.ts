import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'shared', include: ['packages/shared/**/*.test.ts'] } },
      {
        // suites share one Postgres and truncate it, so files must not run concurrently
        test: {
          name: 'api',
          include: ['apps/api/**/*.test.ts'],
          environment: 'node',
          fileParallelism: false,
        },
      },
      // LLM-as-judge evals: need LiveKit Cloud credentials, skipped without them.
      { test: { name: 'agent', include: ['apps/agent/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'embed', include: ['apps/embed/**/*.test.ts'], environment: 'jsdom' } },
      { test: { name: 'web', include: ['apps/web/**/*.test.{ts,tsx}'], environment: 'jsdom' } },
    ],
    coverage: {
      provider: 'v8',
      // lcov feeds Codecov and the Sonar scan in CI
      reporter: ['text', 'lcov'],
      // Logic modules carry the gate. LiveKit/React/Fastify wiring (entrypoints,
      // components, DB client, worker glue) is smoke-tested, not line-covered.
      include: [
        'packages/shared/src/**/*.ts',
        'apps/api/src/**/*.ts',
        'apps/embed/src/state.ts',
        'apps/web/src/lib/**/*.ts',
      ],
      exclude: [
        'apps/api/src/index.ts',
        'apps/api/src/db/**',
        'apps/api/src/livekit.ts',
        'apps/api/src/auth.ts',
        'apps/web/src/lib/hooks.ts',
        'apps/web/src/lib/api.ts',
      ],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
