/**
 * Test helpers shared by the unit and integration suites. Not part of the runtime.
 *
 * - {@link testServer}: a real `buildServer` with a fake LiveKit and a switchable session,
 *   so tests exercise routes, `Flow`, `Routing` and the websocket exactly as production does.
 * - {@link freshDb} / {@link resetDb}: a migrated, truncated Postgres (integration tests
 *   skip entirely when {@link dbAvailable} is false).
 * - {@link fakeLiveKit}: records tokens, dispatches and deletions instead of calling the cloud.
 *
 * Connection string: `DATABASE_URL_TEST`, else `DATABASE_URL`, else the docker-compose default.
 *
 * @see apps/api/README.md
 * @packageDocumentation
 */
import dotenv from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { type SessionUser } from './auth.ts';
import { LocalBus } from './bus.ts';
import { type Db, createDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { user } from './db/schema.ts';
import type { LiveKit } from './livekit.ts';
import { buildServer } from './server.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });
process.env.NODE_ENV = 'test';

/** First non-empty of `DATABASE_URL_TEST`, `DATABASE_URL`, docker-compose default. */
const DATABASE_URL = [
  process.env.DATABASE_URL_TEST,
  process.env.DATABASE_URL,
  'postgres://cc:cc@localhost:5432/cc',
].find(Boolean)!;

/**
 * True when a Postgres is reachable; DB-backed suites skip otherwise.
 *
 * @param connectionString - Defaults to the test database (see module docs).
 */
export async function dbAvailable(connectionString = DATABASE_URL): Promise<boolean> {
  try {
    const { db, close } = createDb(connectionString);
    await db.execute(sql`select 1`);
    await close();
    return true;
  } catch {
    return false;
  }
}

/** Migrated, empty database. Call `close()` in `afterAll`. */
export async function freshDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  await runMigrations(DATABASE_URL);
  const { db, close } = createDb(DATABASE_URL);
  await resetDb(db);
  return { db, close };
}

/** Truncates every table (cascading from `user` and `tenant`); Better Auth tables included. */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`truncate "user", tenant restart identity cascade`);
}

/** Inserts a user row directly (no Better Auth, no bootstrap) and returns it as a session user. */
export async function createUser(
  db: Db,
  email: string,
  name = email.split('@')[0]!,
): Promise<SessionUser> {
  const id = randomUUID();
  await db.insert(user).values({ id, email, name, updatedAt: new Date() });
  return { id, email, name };
}

/**
 * Records LiveKit calls instead of talking to the cloud.
 *
 * @returns `livekit` to inject, and `calls` to assert on: `tokens` (the token requests),
 *   `dispatched` and `deleted` (room names). Tokens are `token-for-<identity>`.
 */
export function fakeLiveKit() {
  const calls: { tokens: unknown[]; dispatched: string[]; deleted: string[]; removed: string[] } = {
    tokens: [],
    dispatched: [],
    deleted: [],
    removed: [],
  };
  const livekit: LiveKit = {
    url: 'wss://fake.livekit.cloud',
    async createToken(req) {
      calls.tokens.push(req);
      return `token-for-${req.identity}`;
    },
    async dispatchAgent(room) {
      calls.dispatched.push(room);
    },
    async deleteRoom(room) {
      calls.deleted.push(room);
    },
    async removeParticipant(room, identity) {
      calls.removed.push(`${room}:${identity}`);
    },
  };
  return { livekit, calls };
}

/** Value tests send as `x-internal-secret`. */
export const INTERNAL_SECRET = 'test-secret';

/**
 * Builds a server whose session is whatever `current` holds (switch users per request),
 * or whatever `resolve` returns when given.
 *
 * @param db - From {@link freshDb}.
 * @param adminEmails - Who may `POST /api/admin/tenants`.
 * @param resolve - Optional resolver that overrides `as()`; websocket tests use it because
 *   upgrades happen outside `inject()`.
 * @returns `app`, `as(user)` (sets the current user and returns `app` for chaining),
 *   `hub`, `flow` and `lk` (the fake LiveKit's recorded calls).
 *
 * @example
 * ```ts
 * const srv = await testServer(db, ['boss@x.io']);
 * const res = await srv.as(boss).inject({ method: 'POST', url: '/api/admin/tenants', payload: { name: 'Acme' } });
 * ```
 */
export async function testServer(
  db: Db,
  adminEmails: string[] = [],
  resolve?: () => SessionUser | null,
) {
  const current: { user: SessionUser | null } = { user: null };
  const lk = fakeLiveKit();
  const bus = new LocalBus();
  const { app, hub, flow } = await buildServer({
    db,
    adminEmails,
    livekit: lk.livekit,
    internalSecret: INTERNAL_SECRET,
    bus,
    getSession: async () => (resolve ? resolve() : current.user),
  });
  const as = (u: SessionUser | null) => {
    current.user = u;
    return app;
  };
  return { app, as, hub, flow, lk: lk.calls, bus };
}
