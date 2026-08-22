/**
 * End-to-end tests drive the REAL stack: API (with the dev auth bypass), web desk,
 * embed demo page, the AI agent worker and LiveKit Cloud. They need Postgres and
 * `LIVEKIT_*` credentials in `.env.local`; `npm run test:e2e` is opt-in and not part
 * of `validate`. See tests/README.md.
 */
import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const API_PORT = 4100;
const WEB_PORT = 3100;
const EMBED_PORT = 3101;
export const E2E_USER = 'e2e@example.com';
const env = {
  ...process.env,
  PORT: String(API_PORT),
  API_PORT: String(API_PORT),
  WEB_PORT: String(WEB_PORT),
  API_ORIGIN: `http://localhost:${API_PORT}`,
  WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
  DEV_USER_EMAIL: E2E_USER,
  ADMIN_EMAILS: E2E_USER,
  INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET ?? 'e2e-secret',
};

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'tests/e2e/report' }]],
  outputDir: 'tests/e2e/results',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node src/index.ts',
      cwd: 'apps/api',
      url: `http://localhost:${API_PORT}/api/health`,
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
      url: `http://localhost:${EMBED_PORT}`,
      env,
      reuseExistingServer: false,
    },
  ],
});

export const EMBED_ORIGIN = `http://localhost:${EMBED_PORT}`;
