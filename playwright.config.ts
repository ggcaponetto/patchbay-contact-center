/**
 * End-to-end tests drive the REAL stack: API (with the dev auth bypass), web desk,
 * embed demo page and — for the `cloud` tier — the AI agent worker and LiveKit Cloud.
 * Three projects are the execution tiers (see tests/e2e/TEST-PLAN.md):
 *
 * - `smoke` — `@smoke` tests: boots and one happy path per app, under a minute.
 * - `core`  — everything except `@cloud`: the whole desk/routing/settings surface with the
 *   AI *played* through `/api/internal` and dummy LiveKit credentials, no Cloud needed.
 * - `cloud` — `@cloud` tests: real agent worker, real audio rooms; needs `LIVEKIT_*`.
 *
 * The API runs against its own database (`cc_e2e`, reset by `global-setup.ts`), so the
 * development data is never touched. See tests/README.md.
 */
import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const API_PORT = 4100;
const WEB_PORT = 3100;
const EMBED_PORT = 3101;

/** The default dev user: supervisor of the bootstrapped tenant (listed in `ADMIN_EMAILS`). */
export const E2E_USER = 'e2e@example.com';
/** Where the API listens during a run; specs call it directly for public/internal routes. */
export const API_ORIGIN = `http://localhost:${API_PORT}`;
/** The embed demo page ("any website") with the call button. */
export const EMBED_ORIGIN = `http://localhost:${EMBED_PORT}`;
/** Shared secret the specs use to play the AI worker against `/api/internal/*`. */
export const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? 'e2e-secret';
/** True when real LiveKit Cloud credentials are present (the `cloud` tier can run). */
export const HAS_CLOUD = Boolean(process.env.LIVEKIT_API_KEY);

/**
 * The API needs a database of its own: `DATABASE_URL_E2E`, or `DATABASE_URL` with the
 * database name swapped for `cc_e2e` (`tests/e2e/reset-db.ts` creates and resets it).
 */
export const E2E_DATABASE_URL =
  process.env.DATABASE_URL_E2E ??
  (process.env.DATABASE_URL ?? 'postgres://cc:cc@localhost:5432/cc').replace(
    /\/[^/?]*(\?|$)/,
    '/cc_e2e$1',
  );

const env = {
  ...process.env,
  // Without Cloud the API still boots and mints (unusable) tokens: enough for `core`.
  LIVEKIT_URL: process.env.LIVEKIT_URL || 'wss://e2e.invalid',
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY || 'e2e-key',
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET || 'e2e-secret-that-is-long-enough-for-jwt',
  DATABASE_URL: E2E_DATABASE_URL,
  PORT: String(API_PORT),
  API_PORT: String(API_PORT),
  WEB_PORT: String(WEB_PORT),
  API_ORIGIN,
  WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
  DEV_USER_EMAIL: E2E_USER,
  // No seeded demo team: the specs create exactly the people they need.
  DEV_DEMO_TEAM: 'false',
  ADMIN_EMAILS: E2E_USER,
  INTERNAL_API_SECRET: INTERNAL_SECRET,
  // Recording controls work everywhere without S3: no Egress is actually started.
  RECORDING_STUB: 'true',
};

const chromium = {
  ...devices['Desktop Chrome'],
  launchOptions: {
    // A synthetic microphone and no permission prompt, so getUserMedia succeeds headless.
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
};

export default defineConfig({
  testDir: 'tests/e2e/specs',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: process.env.CI ? 1 : 0,
  // The API's routing state is in-memory and the tiers share one tenant: stay serial.
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/e2e/report' }]],
  outputDir: 'tests/e2e/results',
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'smoke', grep: /@smoke/, use: chromium },
    { name: 'core', grepInvert: /@cloud/, use: chromium },
    { name: 'cloud', grep: /@cloud/, use: chromium },
  ],
  webServer: [
    {
      // reset-db.ts prepares the e2e database, then the API boots against it.
      command: 'node ../../tests/e2e/reset-db.ts && node src/index.ts',
      cwd: 'apps/api',
      url: `${API_ORIGIN}/api/health`,
      env,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npx vite',
      cwd: 'apps/web',
      url: `http://localhost:${WEB_PORT}`,
      env,
      reuseExistingServer: false,
    },
    {
      command: `npx vite --port ${EMBED_PORT}`,
      cwd: 'apps/embed',
      url: EMBED_ORIGIN,
      env,
      reuseExistingServer: false,
    },
  ],
});
