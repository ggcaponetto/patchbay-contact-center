/**
 * Test taxonomy (see tests/README.md):
 * - unit:        `*.test.ts(x)` next to the source, no external services
 * - integration: `*.integration.test.ts` next to the source; need Postgres and/or
 *                LiveKit Cloud credentials and skip themselves when those are absent
 * - e2e / load:  Playwright (`tests/e2e`) and Artillery (`tests/load`), not run by vitest
 *
 * `npm test` runs unit + integration with the coverage gate; `npm run test:unit`
 * and `npm run test:integration` select one project.
 */
import { defineConfig } from 'vitest/config';

const UNIT = ['**/*.test.{ts,tsx}'];
const INTEGRATION = ['**/*.integration.test.{ts,tsx}'];
const IGNORE = ['**/node_modules/**', '**/dist/**', 'tests/**'];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: UNIT,
          exclude: [...IGNORE, ...INTEGRATION],
          // Browser-side code (web, embed) declares `// @vitest-environment jsdom` per file.
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: INTEGRATION,
          exclude: IGNORE,
          environment: 'node',
          // API suites share one Postgres and truncate it, so files must not run concurrently.
          fileParallelism: false,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // lcov feeds Codecov and the Sonar scan in CI
      reporter: ['text', 'lcov'],
      // Every source file counts. Entrypoints are kept tiny and wiring is tested with
      // fakes (see tests/README.md); only test files themselves are left out.
      include: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.test.tsx'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
