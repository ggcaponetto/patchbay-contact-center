import type { FastifyPluginAsync } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth } from './auth.ts';
import type { Db } from './db/client.ts';
import { buildServer } from './server.ts';
import { fakeLiveKit } from './testing.ts';

const fakes = vi.hoisted(() => ({
  embedDistExists: { value: false },
  staticOpts: [] as unknown[],
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, default: fs, existsSync: () => fakes.embedDistExists.value };
});
vi.mock('@fastify/static', () => {
  const plugin: FastifyPluginAsync<{ prefix: string }> = async (app, opts) => {
    fakes.staticOpts.push(opts);
    app.get('/call-button.js', async () => 'bundle');
  };
  return { default: plugin };
});

/**
 * Database stand-in: every query builder chain resolves to no rows, which is all the
 * requests below need (`buildServer` itself never queries).
 */
const empty: Record<string, unknown> = {};
for (const m of [
  'select',
  'from',
  'innerJoin',
  'where',
  'orderBy',
  'limit',
  'update',
  'set',
  'returning',
]) {
  empty[m] = () => empty;
}
empty.then = (resolve: (rows: never[]) => void) => resolve([]);
const db = empty as unknown as Db;
const getSession = async () => null;

describe('buildServer', () => {
  const apps: { close(): Promise<unknown> }[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    fakes.embedDistExists.value = false;
    fakes.staticOpts.length = 0;
    await Promise.all(apps.map((a) => a.close()));
    apps.length = 0;
  });
  const build = async (deps: Partial<Parameters<typeof buildServer>[0]>) => {
    const built = await buildServer({ db, livekit: fakeLiveKit().livekit, ...deps });
    apps.push(built.app);
    return built;
  };

  it('refuses to start without an auth strategy or an internal secret', async () => {
    await expect(build({ internalSecret: 's' })).rejects.toThrow(
      'buildServer needs `auth`, `devUserEmail` or `getSession`',
    );
    vi.stubEnv('INTERNAL_API_SECRET', '');
    await expect(build({ getSession })).rejects.toThrow('INTERNAL_API_SECRET is not set');
    vi.stubEnv('INTERNAL_API_SECRET', undefined);
    vi.stubEnv('ADMIN_EMAILS', undefined);
    await expect(build({ getSession })).rejects.toThrow('INTERNAL_API_SECRET is not set');
  });

  it('reads ADMIN_EMAILS and INTERNAL_API_SECRET from the environment by default', async () => {
    vi.stubEnv('ADMIN_EMAILS', ' Boss@Example.com ,, ');
    vi.stubEnv('INTERNAL_API_SECRET', 'env-secret');
    const { app } = await build({
      getSession: async () => ({ id: 'u1', email: 'boss@example.com', name: 'Boss' }),
    });
    const health = await app.inject({ url: '/api/health' });
    expect(health.json()).toEqual({ ok: true });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('DENY');
    const root = await app.inject({ url: '/' });
    expect(root.headers['content-type']).toContain('text/html');
    expect(root.body).toContain('/api/health');
    const me = await app.inject({ url: '/api/me' });
    expect(me.json()).toEqual({
      user: { id: 'u1', email: 'boss@example.com', name: 'Boss' },
      isAdmin: true,
      memberships: [],
      permissions: [],
      devMode: false,
    });
    const denied = await app.inject({ method: 'POST', url: '/api/internal/calls/x/status' });
    expect(denied.statusCode).toBe(401);
    const accepted = await app.inject({
      url: '/api/internal/calls/x',
      headers: { 'x-internal-secret': 'env-secret' },
    });
    expect(accepted.statusCode).toBe(404);
  });

  it('documents every route in /api/openapi.json, built from the zod contracts', async () => {
    const { app } = await build({ getSession, internalSecret: 's' });
    const res = await app.inject({ url: '/api/openapi.json' });
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('Patchbay Contact Center API');
    // every registered API route is in the document (the auth handler and the root
    // page are the only undocumented ones)
    const registered = app
      .printRoutes({ commonPrefix: false })
      .split(/\r?\n/)
      .map((l) => /^(?:[│├└─\s]*)(\/\S*) \(([A-Z, ]+)\)/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null && m[1]!.startsWith('/api/'))
      .filter((m) => !m[1]!.startsWith('/api/auth') && !m[1]!.startsWith('/api/ws'))
      .map((m) => m[1]!.replace(/:(\w+)/g, '{$1}'));
    for (const path of registered) expect(Object.keys(doc.paths)).toContain(path);
    // Fastify's implicit HEAD twins of the GET routes are not documented.
    const methods = Object.values(doc.paths).flatMap((ops) => Object.keys(ops as object));
    expect(methods).toContain('get');
    expect(methods).not.toContain('head');
    const accept = doc.paths['/api/desk/calls/{id}/accept'].post;
    expect(accept).toMatchObject({
      'x-permission': 'calls:answer',
      parameters: [{ name: 'id', in: 'path', required: true }],
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    });
    expect(accept.responses['200'].content['application/json'].schema.properties.token).toEqual({
      type: 'string',
    });
    expect(accept.responses['409'].description).toContain('not_ringing_you');
    const state = doc.paths['/api/desk/state'].post;
    expect(state.requestBody.content['application/json'].schema.properties.state.enum).toEqual([
      'ready',
      'not_ready',
    ]);
    expect(doc.paths['/api/public/calls'].post.security).toEqual([]);
    expect(doc.paths['/api/internal/calls/{id}/escalate'].post.description).toContain(
      'x-internal-secret',
    );
    expect(doc.paths['/api/admin/tenants'].post.description).toContain('ADMIN_EMAILS');
    expect(doc.paths['/api/me'].get.description).toContain('Any signed-in');
  });

  it('serves the embed bundle only when apps/embed/dist exists', async () => {
    const without = await build({ getSession, internalSecret: 's' });
    expect((await without.app.inject({ url: '/embed/call-button.js' })).statusCode).toBe(404);
    fakes.embedDistExists.value = true;
    const withDist = await build({ getSession, internalSecret: 's' });
    expect((await withDist.app.inject({ url: '/embed/call-button.js' })).body).toBe('bundle');
    expect(fakes.staticOpts[0]).toMatchObject({ prefix: '/embed/', decorateReply: false });
    expect((fakes.staticOpts[0] as { root: string }).root).toMatch(/embed[\\/]dist[\\/]$/);
  });

  it('mounts Better Auth when given an auth instance', async () => {
    const handler = vi.fn(async () => new Response('{"session":null}', { status: 200 }));
    const auth = { handler, api: { getSession: async () => null } } as unknown as Auth;
    const { app } = await build({ auth, internalSecret: 's' });
    const res = await app.inject({ url: '/api/auth/get-session' });
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await app.inject({ url: '/api/me' })).statusCode).toBe(401);
  });
  it('rate-limits POST /api/public/calls per client IP (PUBLIC_CALLS_PER_MINUTE, TRUST_PROXY)', async () => {
    const call = (app: Awaited<ReturnType<typeof build>>['app'], ip?: string) =>
      app.inject({
        method: 'POST',
        url: '/api/public/calls',
        payload: {},
        headers: ip ? { 'x-forwarded-for': ip } : {},
      });
    vi.stubEnv('PUBLIC_CALLS_PER_MINUTE', '2');
    vi.stubEnv('TRUST_PROXY', 'true');
    const { app } = await build({ getSession, internalSecret: 's' });
    expect((await call(app, '1.1.1.1')).statusCode).toBe(400);
    expect((await call(app, '1.1.1.1')).statusCode).toBe(400);
    const limited = await call(app, '1.1.1.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: 'rate_limited' });
    expect(limited.json().message).toContain('try again in');
    // Another forwarded IP has a budget of its own; health checks are never limited.
    expect((await call(app, '2.2.2.2')).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);

    // Without a trusted proxy the forwarded header is ignored: one shared socket address.
    const direct = await build({ getSession, internalSecret: 's', trustProxy: false });
    await call(direct.app, '1.1.1.1');
    await call(direct.app, '2.2.2.2');
    expect((await call(direct.app, '3.3.3.3')).statusCode).toBe(429);

    // 0 turns the limit off.
    const unlimited = await build({ getSession, internalSecret: 's', publicCallsPerMinute: 0 });
    for (let i = 0; i < 5; i++) expect((await call(unlimited.app)).statusCode).toBe(400);
  });
});
