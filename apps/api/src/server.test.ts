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
    });
    const denied = await app.inject({ method: 'POST', url: '/api/internal/calls/x/status' });
    expect(denied.statusCode).toBe(401);
    const accepted = await app.inject({
      url: '/api/internal/calls/x',
      headers: { 'x-internal-secret': 'env-secret' },
    });
    expect(accepted.statusCode).toBe(404);
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
});
