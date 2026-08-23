import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEV_USER_HEADER } from './auth.ts';
import type { Db } from './db/client.ts';
import { user } from './db/schema.ts';
import { buildServer } from './server.ts';
import { DEMO_TEAM, seedDemoTeam } from './services/demo.ts';
import { listQueues, membershipsOf } from './services/tenants.ts';
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

  const devServer = async (email: string, adminEmails: string[] = [], devDemoTeam = false) => {
    const { app } = await buildServer({
      db,
      livekit: fakeLiveKit().livekit,
      devUserEmail: email,
      devDemoTeam,
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

  it('lists dev users, switches with a cookie and signs out back to the default', async () => {
    const app = await devServer('dev@example.com', ['dev@example.com']);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/dev-switch', payload: {} });
    expect(bad.statusCode).toBe(400);
    const sw = await app.inject({
      method: 'POST',
      url: '/api/auth/dev-switch',
      payload: { email: ' Alice@Example.com ' },
    });
    expect(sw.json()).toMatchObject({ email: 'alice@example.com', name: 'alice' });
    expect(sw.headers['set-cookie']).toBe('cc_dev_user=alice%40example.com; Path=/; SameSite=Lax');
    const list = await app.inject({
      url: '/api/auth/dev-users',
      headers: { cookie: sw.headers['set-cookie'] as string },
    });
    expect(list.json()).toEqual({
      current: 'alice@example.com',
      users: [
        expect.objectContaining({ email: 'alice@example.com' }),
        expect.objectContaining({ email: 'dev@example.com' }),
      ],
    });
    const me = await app.inject({ url: '/api/me' });
    expect(me.json()).toMatchObject({ devMode: true });
    const out = await app.inject({ method: 'POST', url: '/api/auth/sign-out' });
    expect(out.headers['set-cookie']).toContain('Max-Age=0');
  });

  it("seeds the demo team into the dev user's tenant, once", async () => {
    const app = await devServer('dev@example.com', ['dev@example.com'], true);
    const [home] = await membershipsOf(
      db,
      (await app.inject({ url: '/api/me' })).json().user.id as string,
    );
    const members = await app.inject({ url: '/api/admin/members' });
    expect(members.json()).toEqual(
      expect.arrayContaining(
        DEMO_TEAM.map((p) => expect.objectContaining({ email: p.email, role: p.role })),
      ),
    );
    const queues = await listQueues(db, home!.tenantId);
    expect(queues.map((q) => q.key).sort()).toEqual(['sales', 'support']);
    expect(queues.find((q) => q.key === 'sales')!.memberIds).toHaveLength(2);
    // support: the dev supervisor (bootstrap) + sam, alice, bob, carol
    expect(queues.find((q) => q.key === 'support')!.memberIds).toHaveLength(5);
    expect(await seedDemoTeam(db, home!.tenantId)).toBe(0);
    expect(await db.select().from(user)).toHaveLength(1 + DEMO_TEAM.length);
  });

  it('switches to another dev user through the cc_dev_user cookie', async () => {
    const app = await devServer('dev@example.com', ['dev@example.com']);
    await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { email: 'agent@example.com', role: 'agent' },
    });
    const headers = { cookie: 'other=1; cc_dev_user=Agent%40example.com' };
    const me = await app.inject({ url: '/api/me', headers });
    // created on first use and bootstrapped: the pending invite became a membership
    expect(me.json()).toMatchObject({
      user: { email: 'agent@example.com', name: 'agent' },
      isAdmin: false,
      memberships: [{ role: 'agent' }],
    });
    const session = await app.inject({ url: '/api/auth/get-session', headers });
    expect(session.json().user.email).toBe('agent@example.com');
    // the default user is untouched and the row is reused on the next request
    expect((await app.inject({ url: '/api/me' })).json().user.email).toBe('dev@example.com');
    await app.inject({ url: '/api/me', headers });
    expect(await db.select().from(user)).toHaveLength(2);
  });

  it('picks the dev user from the x-dev-user header, which beats the cookie', async () => {
    const app = await devServer('dev@example.com', ['dev@example.com']);
    await app.inject({
      method: 'POST',
      url: '/api/admin/invites',
      payload: { email: 'tab@example.com', role: 'agent' },
    });
    const me = await app.inject({
      url: '/api/me',
      headers: { [DEV_USER_HEADER]: ' Tab@Example.com ' },
    });
    expect(me.json()).toMatchObject({
      user: { email: 'tab@example.com', name: 'tab' },
      memberships: [{ role: 'agent' }],
    });
    const session = await app.inject({
      url: '/api/auth/get-session',
      headers: { [DEV_USER_HEADER]: 'tab@example.com' },
    });
    expect(session.json().user.email).toBe('tab@example.com');
    // header > cookie > default
    const both = await app.inject({
      url: '/api/auth/dev-users',
      headers: { [DEV_USER_HEADER]: 'tab@example.com', cookie: 'cc_dev_user=other%40example.com' },
    });
    expect(both.json().current).toBe('tab@example.com');
    const cookieOnly = await app.inject({
      url: '/api/auth/dev-users',
      headers: { cookie: 'cc_dev_user=other%40example.com' },
    });
    expect(cookieOnly.json().current).toBe('other@example.com');
  });

  it('ignores a malformed x-dev-user header (falls back to cookie, then default)', async () => {
    const app = await devServer('dev@example.com', ['dev@example.com']);
    for (const bad of ['', 'not-an-email', 'two@@x y', 'a@b c']) {
      const me = await app.inject({ url: '/api/me', headers: { [DEV_USER_HEADER]: bad } });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.email).toBe('dev@example.com');
    }
    const withCookie = await app.inject({
      url: '/api/me',
      headers: { [DEV_USER_HEADER]: 'nope', cookie: 'cc_dev_user=cookie%40example.com' },
    });
    expect(withCookie.json().user.email).toBe('cookie@example.com');
    // a bad cookie is ignored the same way
    const badCookie = await app.inject({ url: '/api/me', headers: { cookie: 'cc_dev_user=junk' } });
    expect(badCookie.json().user.email).toBe('dev@example.com');
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
