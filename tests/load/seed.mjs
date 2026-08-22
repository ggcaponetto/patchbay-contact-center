#!/usr/bin/env node
/**
 * Seeds the load test and runs Artillery. Expects the API on :4100 started with
 * `DEV_USER_EMAIL` set to an admin email (so the dev user owns a tenant): creates an
 * embed key through the admin API and passes it to Artillery as LOAD_EMBED_KEY.
 */
import { spawnSync } from 'node:child_process';

const API = process.env.LOAD_API ?? 'http://localhost:4100';
const res = await fetch(`${API}/api/admin/embed-keys`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ label: `load-${Date.now()}`, allowedOrigins: [] }),
}).catch((err) => ({ ok: false, status: 0, text: async () => String(err) }));
if (!res.ok) {
  console.error(`seed failed: ${res.status} ${await res.text()}`);
  console.error('Start the API first: PORT=4100 DEV_USER_EMAIL=<admin email> npm run dev:api');
  process.exit(1);
}
const { publicKey } = await res.json();
console.log(`seeded embed key ${publicKey}`);
const run = spawnSync('npx', ['artillery', 'run', 'tests/load/api.yml'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, LOAD_EMBED_KEY: publicKey },
});
process.exit(run.status ?? 1);
