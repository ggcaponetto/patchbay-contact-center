import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './db/client.ts';
import { user } from './db/schema.ts';
import { buildServer } from './server.ts';
import { membershipsOf } from './services/tenants.ts';
import {
  INTERNAL_SECRET,
  createUser,
  dbAvailable,
  fakeLiveKit,
  freshDb,
  resetDb,
} from './testing.ts';

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)('devAuth', () => {
  let db: Db;
  let close: () => Promise<void>;
  const apps: { close(): Promise<unknown> }[] = [];

  beforeAll(async () => {
    ({ db, close } = await freshDb());
  });
  afterAll(async () => {
    await Promise.all(apps.map((a) => a.close()));
    await close();
  });
  beforeEach(() => resetDb(db));

  const devServer = async (email: string, adminEmails: string[] = []) => {
    const { app } = await buildServer({
      db,
      livekit: fakeLiveKit().livekit,
      devUserEmail: email,
      adminEmails,
      internalSecret: INTERNAL_SECRET,
    });
    apps.push(app);
    return app;
  };

  it('creates and bootstraps the dev user, then answers the auth client stubs', async () => {
    const app = await devServer('dev@example.com', ['dev@example.com']);
    const [row] = await db.select().from(user).where(eq(user.email, 'dev@example.com'));
    expect(row).toMatchObject({ email: 'dev@example.com', name: 'dev' });
    // ADMIN_EMAILS bootstrap gave the dev user a tenant of their own
    expect(await membershipsOf(db, row!.id)).toMatchObject([{ role: 'supervisor' }]);

    const me = await app.inject({ url: '/api/me', headers: { cookie: 'ignored=yes' } });
    expect(me.json()).toMatchObject({
      user: { id: row!.id, email: 'dev@example.com', name: 'dev' },
      isAdmin: true,
    });
    const session = await app.inject({ url: '/api/auth/get-session' });
    expect(session.json()).toMatchObject({
      session: { id: 'dev', userId: row!.id },
      user: { id: row!.id, email: 'dev@example.com' },
    });
    expect(new Date(session.json().session.expiresAt).getTime()).toBeGreaterThan(Date.now());
    const signOut = await app.inject({ method: 'POST', url: '/api/auth/sign-out' });
    expect(signOut.json()).toEqual({ success: true });
  });

  it('reuses an existing user row without bootstrapping again', async () => {
    const existing = await createUser(db, 'old@example.com', 'Old Timer');
    const app = await devServer('old@example.com', ['old@example.com']);
    const me = await app.inject({ url: '/api/me' });
    expect(me.json()).toMatchObject({
      user: { id: existing.id, name: 'Old Timer' },
      isAdmin: true,
      memberships: [],
    });
    expect(await db.select().from(user)).toHaveLength(1);
  });
});
