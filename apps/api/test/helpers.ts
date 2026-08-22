import dotenv from 'dotenv';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { type SessionUser } from '../src/auth.ts';
import { type Db, createDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { user } from '../src/db/schema.ts';
import type { LiveKit } from '../src/livekit.ts';
import { buildServer } from '../src/server.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });
process.env.NODE_ENV = 'test';

const DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL ?? 'postgres://cc:cc@localhost:5432/cc';

/** True when a Postgres is reachable; DB-backed suites skip otherwise. */
export async function dbAvailable(): Promise<boolean> {
  try {
    const { db, close } = createDb(DATABASE_URL);
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

export async function resetDb(db: Db): Promise<void> {
  await db.execute(sql`truncate "user", tenant restart identity cascade`);
}

export async function createUser(
  db: Db,
  email: string,
  name = email.split('@')[0]!,
): Promise<SessionUser> {
  const id = randomUUID();
  await db.insert(user).values({ id, email, name, updatedAt: new Date() });
  return { id, email, name };
}

/** Records LiveKit calls instead of talking to the cloud. */
export function fakeLiveKit() {
  const calls: { tokens: unknown[]; dispatched: string[]; deleted: string[] } = {
    tokens: [],
    dispatched: [],
    deleted: [],
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
  };
  return { livekit, calls };
}

export const INTERNAL_SECRET = 'test-secret';

/** Builds a server whose session is whatever `current` holds (switch users per request). */
export async function testServer(db: Db, adminEmails: string[] = []) {
  const current: { user: SessionUser | null } = { user: null };
  const lk = fakeLiveKit();
  const { app, hub } = await buildServer({
    db,
    adminEmails,
    livekit: lk.livekit,
    internalSecret: INTERNAL_SECRET,
    getSession: async () => current.user,
  });
  const as = (u: SessionUser | null) => {
    current.user = u;
    return app;
  };
  return { app, as, hub, lk: lk.calls };
}
