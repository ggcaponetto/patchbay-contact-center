#!/usr/bin/env node
/**
 * Dynamic application security testing (DAST): `npm run dast`.
 *
 * Boots the API against the local Postgres (`docker compose up -d`), waits for
 * `/api/health`, then runs the OWASP ZAP **baseline scan** (spider + passive rules,
 * no attacks) from the official `ghcr.io/zaproxy/zaproxy:stable` image against it,
 * and shuts the API down again. Works the same on a laptop and in CI
 * (`.github/workflows/dast.yml`); the only requirement besides Postgres is Docker.
 *
 * The target is the API as a stranger sees it — no session, no `DEV_USER_EMAIL` — so
 * the scan covers the unauthenticated surface: health, the public call endpoint, the
 * embed bundle and the auth routes. Alerts at WARN level are reported, FAIL-level
 * alerts fail the run; the level per rule is tuned in `build/zap-rules.tsv`.
 *
 * Reports (HTML + JSON) land in `reports/dast/`, git-ignored and uploaded as a CI
 * artifact. Override the port with `DAST_PORT` (default 4010, deliberately not the dev
 * server's 4000).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'reports', 'dast');
const PORT = Number(process.env.DAST_PORT ?? 4010);
const ZAP_IMAGE = 'ghcr.io/zaproxy/zaproxy:stable';
const HEALTH_TIMEOUT_MS = 60_000;

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'build', 'zap-rules.tsv'), path.join(OUT, 'rules.tsv'));

// 1. Start the API exactly as `npm start -w apps/api` would, on its own port. The
//    dev bypass is cleared so the scan sees the production auth surface.
const api = spawn('node', ['src/index.ts'], {
  cwd: path.join(ROOT, 'apps', 'api'),
  env: { ...process.env, PORT: String(PORT), DEV_USER_EMAIL: '', NODE_ENV: 'production' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const stopApi = () => {
  if (api.exitCode === null) api.kill();
};
process.on('exit', stopApi);

/** Polls `/api/health` until it answers or the timeout elapses. */
async function waitForApi() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new Error(`API exited with code ${api.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`API did not answer on :${PORT} within ${HEALTH_TIMEOUT_MS / 1000}s`);
}

try {
  await waitForApi();
  console.log(`dast: API is up on :${PORT}, running ZAP baseline`);
  // ZAP lives in a container; host.docker.internal reaches the API on the host
  // (Docker Desktop resolves it natively, `host-gateway` does the same on Linux).
  const zap = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--add-host=host.docker.internal:host-gateway',
      '-v',
      `${OUT}:/zap/wrk:rw`,
      ZAP_IMAGE,
      'zap-baseline.py',
      '-t',
      `http://host.docker.internal:${PORT}`,
      '-c',
      'rules.tsv',
      '-r',
      'report.html',
      '-J',
      'report.json',
      '-I', // WARN alerts are informational; only FAIL (see zap-rules.tsv) breaks the run
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  // zap-baseline exit codes: 0 pass, 1 FAIL alerts, 2 WARN (suppressed by -I), 3 error
  const status = zap.status ?? 3;
  if (status === 0) {
    console.log('dast: OK — no failing alerts (see reports/dast/report.html)');
  } else {
    console.error(`dast: FAILED with ZAP exit code ${status} (see reports/dast/report.html)`);
  }
  process.exitCode = status === 0 ? 0 : 1;
} catch (err) {
  console.error(`dast: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  stopApi();
}
