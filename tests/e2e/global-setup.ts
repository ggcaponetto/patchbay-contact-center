/**
 * Starts the AI agent worker for the `cloud` tier and waits until it has registered with
 * LiveKit Cloud. Playwright's `webServer` can only wait on a URL/port, which a worker
 * does not have, hence this global setup. The process is killed in the returned teardown.
 * Nothing happens for the other tiers (they play the AI through `/api/internal`) or
 * without `LIVEKIT_*` credentials.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { API_ORIGIN, HAS_CLOUD, INTERNAL_SECRET } from '../../playwright.config.ts';

/** True when the CLI selected the `cloud` project (`--project cloud` / `--project=cloud`). */
const cloudSelected = process.argv.some(
  (a, i) => a === '--project=cloud' || (process.argv[i - 1] === '--project' && a === 'cloud'),
);

export default async function globalSetup(): Promise<() => void> {
  if (!HAS_CLOUD || !cloudSelected) return () => undefined;
  const env = { ...process.env, API_ORIGIN, INTERNAL_API_SECRET: INTERNAL_SECRET };
  // No shell: on Windows `kill()` would only stop the cmd.exe wrapper and leave the
  // worker running, and a stale worker then steals the next dispatch.
  const worker: ChildProcess = spawn(process.execPath, ['src/main.ts', 'dev'], {
    cwd: 'apps/agent',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Worker output lands in tests/e2e/results/agent.log for debugging failed runs.
  fs.mkdirSync('tests/e2e/results', { recursive: true });
  const log = fs.createWriteStream('tests/e2e/results/agent.log');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('agent worker did not register')), 60_000);
    const watch = (chunk: Buffer) => {
      log.write(chunk);
      if (String(chunk).includes('registered worker')) {
        clearTimeout(timer);
        resolve();
      }
    };
    worker.stdout?.on('data', watch);
    worker.stderr?.on('data', watch);
    worker.on('exit', (code) => reject(new Error(`agent worker exited with ${code}`)));
  });
  return () => {
    // The worker forks job processes; kill the whole tree.
    if (process.platform === 'win32' && worker.pid) {
      spawnSync('taskkill', ['/pid', String(worker.pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      worker.kill('SIGTERM');
    }
  };
}
