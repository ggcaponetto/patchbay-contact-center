import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Auth, createAuth, registerAuth } from './auth.ts';
import type { Db } from './db/client.ts';

const fakes = vi.hoisted(() => ({ bootstrapUser: vi.fn(async () => undefined) }));
vi.mock('./services/tenants.ts', () => ({ bootstrapUser: fakes.bootstrapUser }));

/** A stand-in for Better Auth: records the Fetch `Request` it got and answers with `response`. */
function fakeAuth(response: () => Response, session: unknown = null) {
  const seen: Request[] = [];
  const auth = {
    handler: async (req: Request) => {
      seen.push(req);
      return response();
    },
    api: { getSession: vi.fn(async () => session) },
  };
  return { auth: auth as unknown as Auth, seen, getSession: auth.api.getSession };
}

describe('registerAuth', () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.map((a) => a.close()));
    apps.length = 0;
  });
  const build = async (fake: ReturnType<typeof fakeAuth>) => {
    const app = Fastify();
    const getSession = registerAuth(app, fake.auth);
    apps.push(app);
    return { app, getSession };
  };

  it('translates a JSON POST into a Fetch Request and copies the Response back', async () => {
    const fake = fakeAuth(
      () =>
        new Response('{"ok":true}', {
          status: 201,
          headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc; Path=/' },
        }),
    );
    const { app } = await build(fake);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/social?x=1',
      headers: { host: 'localhost:3000', cookie: 'a=b' },
      payload: { provider: 'google' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['set-cookie']).toBe('sid=abc; Path=/');
    expect(res.json()).toEqual({ ok: true });
    const [req] = fake.seen;
    expect(req!.url).toBe('http://localhost:3000/api/auth/sign-in/social?x=1');
    expect(req!.method).toBe('POST');
    expect(req!.headers.get('cookie')).toBe('a=b');
    expect(await req!.json()).toEqual({ provider: 'google' });
  });

  it('forwards body-less GETs and empty responses', async () => {
    const fake = fakeAuth(() => new Response(null, { status: 204 }));
    const { app } = await build(fake);
    const res = await app.inject({ method: 'GET', url: '/api/auth/get-session' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(fake.seen[0]!.body).toBeNull();
  });

  it('resolves sessions through Better Auth and maps the user', async () => {
    const withSession = fakeAuth(() => new Response(), {
      user: { id: 'u1', email: 'a@b.c', name: 'Ann', image: 'ignored' },
      session: { id: 's1' },
    });
    const { getSession } = await build(withSession);
    expect(await getSession({ cookie: 'sid=abc' })).toEqual({
      id: 'u1',
      email: 'a@b.c',
      name: 'Ann',
    });
    const headers = withSession.getSession.mock.calls[0]![0 as never] as { headers: Headers };
    expect(headers.headers.get('cookie')).toBe('sid=abc');

    const anonymous = fakeAuth(() => new Response(), null);
    expect(await (await build(anonymous)).getSession({})).toBeNull();
  });
});

describe('createAuth', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    fakes.bootstrapUser.mockClear();
  });
  const db = {} as Db;

  it('configures Google, the web origin and the first-login bootstrap', async () => {
    vi.stubEnv('WEB_ORIGIN', 'https://desk.example');
    vi.stubEnv('BETTER_AUTH_SECRET', 'a-very-long-secret-for-better-auth-tests');
    vi.stubEnv('GOOGLE_CLIENT_ID', 'gid');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-secret');
    vi.stubEnv('ADMIN_EMAILS', 'boss@example.com,');
    const auth = createAuth(db);
    expect(auth.options.baseURL).toBe('https://desk.example');
    expect(auth.options.basePath).toBe('/api/auth');
    expect(auth.options.trustedOrigins).toEqual(['https://desk.example']);
    expect(auth.options.socialProviders?.google).toMatchObject({
      clientId: 'gid',
      clientSecret: 'google-secret',
    });
    await auth.options.databaseHooks!.user!.create!.after!(
      { id: 'u1', email: 'boss@example.com', name: 'Boss', image: 'x' } as never,
      undefined as never,
    );
    expect(fakes.bootstrapUser).toHaveBeenCalledWith(
      db,
      { id: 'u1', email: 'boss@example.com', name: 'Boss' },
      ['boss@example.com'],
    );
  });

  it('falls back to localhost and empty credentials', () => {
    for (const name of ['WEB_ORIGIN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ADMIN_EMAILS']) {
      vi.stubEnv(name, undefined);
    }
    vi.stubEnv('BETTER_AUTH_SECRET', 'a-very-long-secret-for-better-auth-tests');
    const auth = createAuth(db);
    expect(auth.options.baseURL).toBe('http://localhost:3000');
    expect(auth.options.socialProviders?.google).toMatchObject({ clientId: '', clientSecret: '' });
  });
});
