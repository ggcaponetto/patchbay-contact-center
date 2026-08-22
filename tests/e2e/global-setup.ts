/**
 * Starts the AI agent worker and the media worker (hold music) for the `cloud` tier and
 * waits until they are ready. Playwright's `webServer` can only wait on a URL/port,
 * which a worker does not have, hence this global setup. The processes are killed in the
 * returned teardown. Nothing happens for the other tiers (they play the AI through
 * `/api/internal`) or without `LIVEKIT_*` credentials.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import {
  API_ORIGIN,
  E2E_DATABASE_URL,
  HAS_CLOUD,
  INTERNAL_SECRET,
} from '../../playwright.config.ts';

/** True when the CLI selected the `cloud` project (`--project cloud` / `--project=cloud`). */
const cloudSelected = process.argv.some(
  (a, i) => a === '--project=cloud' || (process.argv[i - 1] === '--project' && a === 'cloud'),
);

/** Spawns a workspace worker and resolves once `readyLine` appears in its output. */
async function startWorker(
  cwd: string,
  args: string[],
  readyLine: string,
  logFile: string,
  env: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  // No shell: on Windows `kill()` would only stop the cmd.exe wrapper and leave the
  // worker running, and a stale worker then steals the next dispatch.
  const worker: ChildProcess = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = fs.createWriteStream(logFile);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${cwd} worker not ready`)), 60_000);
    const watch = (chunk: Buffer) => {
      log.write(chunk);
      if (String(chunk).includes(readyLine)) {
        clearTimeout(timer);
        resolve();
      }
    };
    worker.stdout?.on('data', watch);
    worker.stderr?.on('data', watch);
    worker.on('exit', (code) => reject(new Error(`${cwd} worker exited with ${code}`)));
  });
  return worker;
}

/** Kills a worker and everything it forked. */
function stopWorker(worker: ChildProcess): void {
  if (process.platform === 'win32' && worker.pid) {
    spawnSync('taskkill', ['/pid', String(worker.pid), '/t', '/f'], { stdio: 'ignore' });
  } else {
    worker.kill('SIGTERM');
  }
}

export default async function globalSetup(): Promise<() => void> {
  if (!HAS_CLOUD || !cloudSelected) return () => undefined;
  const env = {
    ...process.env,
    API_ORIGIN,
    INTERNAL_API_SECRET: INTERNAL_SECRET,
    DATABASE_URL: E2E_DATABASE_URL,
  };
  // Worker output lands in tests/e2e/results/*.log for debugging failed runs.
  fs.mkdirSync('tests/e2e/results', { recursive: true });
  const agent = await startWorker(
    'apps/agent',
    ['src/main.ts', 'dev'],
    'registered worker',
    'tests/e2e/results/agent.log',
    env,
  );
  const media = await startWorker(
    'apps/media',
    ['src/index.ts'],
    'listening for hold-music commands',
    'tests/e2e/results/media.log',
    env,
  );
  return () => {
    stopWorker(agent);
    stopWorker(media);
  };
}
