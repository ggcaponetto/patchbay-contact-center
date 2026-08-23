/**
 * Prepares the dedicated e2e database before the API boots (it is the first half of the
 * API `webServer` command in `playwright.config.ts`): creates `cc_e2e` when it does not
 * exist and truncates the user/tenant trees so every run starts from nothing. Runs
 * before the API — not in `globalSetup`, which Playwright executes only after the
 * servers are up — because the dev-auth bypass caches users it has already created.
 */
import pg from 'pg';
import { E2E_DATABASE_URL } from '../../playwright.config.ts';

const url = new URL(E2E_DATABASE_URL);
const database = url.pathname.slice(1);
const maintenance = new URL(url);
maintenance.pathname = '/postgres';

const admin = new pg.Client({ connectionString: maintenance.toString() });
await admin.connect();
const exists = await admin.query('select 1 from pg_database where datname = $1', [database]);
if (exists.rowCount === 0) await admin.query(`create database "${database}"`);
await admin.end();

const db = new pg.Client({ connectionString: E2E_DATABASE_URL });
await db.connect();
// Same statement as `resetDb` in apps/api/src/testing.ts; the tables do not exist yet on
// the very first run (the API migrates at boot), which is fine.
await db.query('truncate "user", tenant restart identity cascade').catch(() => undefined);
await db.end();
console.log(`e2e: database ${database} ready`);
