/**
 * Composition root: builds the Fastify app from injected dependencies.
 *
 * `buildServer` is the single place where the moving parts meet:
 *
 * - the in-process event hub (`EventEmitter`) that internal routes and `Flow` publish to,
 * - {@link DeskSockets}, the fan-out to connected desk websockets,
 * - {@link Flow}, the call-routing orchestrator (which owns a `Routing` instance),
 * - the `authenticate` preHandler that turns a session into `request.ctx`,
 * - the four route groups (`/api/admin`, `/api/desk`, `/api/public`, `/api/internal`)
 *   and the `/api/ws` websocket.
 *
 * It never listens: `index.ts` does that in production, tests call `app.inject()` or
 * `app.listen({ port: 0 })`. Because every external dependency (database, LiveKit,
 * session lookup) comes in through {@link ServerDeps}, tests swap in fakes without mocking
 * modules (see `testing.ts`).
 *
 * @see apps/api/README.md
 * @packageDocumentation
 */
import { type Permission, ROLE_PERMISSIONS } from '@cc/shared';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Auth, type GetSession, type SessionUser, devAuth, registerAuth } from './auth.ts';
import type { Db } from './db/client.ts';
import { Flow } from './flow.ts';
import type { LiveKit } from './livekit.ts';
import { registerOpenApi } from './openapi.ts';
import { adminRoutes } from './routes/admin.ts';
import { deskRoutes } from './routes/desk.ts';
import { internalRoutes } from './routes/internal.ts';
import { publicRoutes } from './routes/public.ts';
import { resolveApiKey } from './services/apiKeys.ts';
import { membershipsOf } from './services/tenants.ts';
import { DeskSockets, registerWs } from './ws.ts';

/**
 * Everything {@link buildServer} needs from the outside world.
 *
 * Exactly one of `auth`, `devUserEmail` or `getSession` must be provided; they are three
 * ways of answering "who is making this request?":
 *
 * - `auth`: the real Better Auth instance (production and normal development).
 * - `devUserEmail`: every request is signed in as this email (local development without Google).
 * - `getSession`: an arbitrary resolver, used by tests to switch users per request.
 */
export type ServerDeps = {
  db: Db;
  livekit: LiveKit;
  /** Real Better Auth instance; tests pass `getSession` instead. */
  auth?: Auth;
  /** Custom session resolver (tests). Ignored when `auth` or `devUserEmail` is set. */
  getSession?: GetSession;
  /** Dev-only: sign every request in as this email (see `devAuth`). */
  devUserEmail?: string;
  /** With `devUserEmail`: seed the demo team (supervisor + agents) into the dev user's tenant. */
  devDemoTeam?: boolean;
  /** Emails allowed to create tenants; defaults to the `ADMIN_EMAILS` env var. */
  adminEmails?: string[];
  /** Shared secret for `/api/internal`; defaults to the `INTERNAL_API_SECRET` env var. */
  internalSecret?: string;
};

/** Version reported in the OpenAPI document (the root `package.json` version). */
const API_VERSION = '0.1.0';

/**
 * Per-request context filled by the `authenticate` preHandler.
 *
 * `tenantId` is `''` when the user has no membership at all; route hooks turn that into a
 * 403 (`no_tenant`). `role` is the user's role in that tenant and `permissions` what that
 * role (or the API key) allows — routes are guarded by permission, never by role directly.
 * An API key acts as a synthetic user `key:<id>` named after the key.
 */
type Ctx = {
  user: SessionUser;
  tenantId: string;
  role: 'agent' | 'supervisor';
  permissions: ReadonlySet<Permission>;
  actor: 'user' | 'api_key';
};

/** A preHandler that either replies (401/403) or returns `undefined` to let the route run. */
export type Hook = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** What `buildServer` hands every route plugin to guard its routes. */
export type Guards = {
  /** Signed in (cookie or API key); fills `request.ctx`. 401 otherwise. */
  authenticate: Hook;
  /** `authenticate` + a tenant + the permission. 403 `no_tenant` / `forbidden` otherwise. */
  authorize: (permission: Permission) => Hook;
};

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `authenticate` preHandler; only defined on authenticated routes. */
    ctx: Ctx;
  }
}

/**
 * Builds the Fastify instance (not listening, so tests can `inject()`) and its event hub.
 *
 * Registration order: CORS, the hardening headers hook and `/api/health` first, then the static embed bundle (only if
 * `apps/embed/dist` exists), the auth handler, `/api/me`, the route groups and finally the
 * websocket. Route groups are Fastify plugins that receive their dependencies as plugin
 * options, so each file lists exactly what it uses.
 *
 * @param deps - See {@link ServerDeps}.
 * @returns `app` (Fastify), `hub` (the event bus) and `flow` (the routing orchestrator),
 *   so tests can listen for events or inspect presence directly.
 * @throws Error when no auth strategy is given or `INTERNAL_API_SECRET` is empty; the API
 *   must never start with an unauthenticated internal surface.
 *
 * @example
 * ```ts
 * const { app } = await buildServer({ db, livekit, getSession: async () => user, internalSecret: 's' });
 * const res = await app.inject({ method: 'GET', url: '/api/me' });
 * ```
 */
export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.decorateRequest('ctx');
  await app.register(cors, { origin: true, credentials: true });
  // Baseline hardening headers on every reply (checked by the DAST scan, build/dast.mjs).
  app.addHook('onSend', async (_request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
  });
  registerOpenApi(app, { title: 'Patchbay Contact Center API', version: API_VERSION });
  app.get(
    '/api/health',
    { config: { doc: { summary: 'Liveness', access: 'public', tag: 'meta' } } },
    async () => ({ ok: true }),
  );
  // Root page: tells a human what this origin is and gives crawlers (the DAST spider,
  // build/dast.mjs) the unauthenticated surface to walk.
  app.get('/', async (_request, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .send(
        '<!doctype html><title>Contact Center API</title><h1>Contact Center API</h1>' +
          '<ul><li><a href="/api/health">/api/health</a></li>' +
          '<li><a href="/embed/call-button.js">/embed/call-button.js</a></li>' +
          '<li><a href="/api/auth/get-session">/api/auth/get-session</a></li>' +
          '<li><a href="/api/me">/api/me</a></li></ul>',
      ),
  );
  // Serve the built call button so websites can load it from the API origin.
  const embedDist = fileURLToPath(new URL('../../embed/dist/', import.meta.url));
  if (existsSync(embedDist)) {
    await app.register(fastifyStatic, { root: embedDist, prefix: '/embed/', decorateReply: false });
  }

  const adminEmails = (deps.adminEmails ?? (process.env.ADMIN_EMAILS ?? '').split(','))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const getSession = deps.auth
    ? registerAuth(app, deps.auth)
    : deps.devUserEmail
      ? await devAuth(app, deps.db, deps.devUserEmail, adminEmails, deps.devDemoTeam)
      : deps.getSession;
  if (!getSession) throw new Error('buildServer needs `auth`, `devUserEmail` or `getSession`');

  /**
   * Resolves the signed-in user and the tenant selected by `x-tenant-id` (or the first one).
   * Replies 401 when there is no session; otherwise fills `request.ctx` and returns
   * `undefined` so the route handler runs. Route files wrap this to add role checks.
   */
  const authenticate: Hook = async (request, reply) => {
    const bearer = /^Bearer\s+(ak_[0-9a-f]+)$/i.exec(String(request.headers.authorization ?? ''));
    if (bearer) {
      const key = await resolveApiKey(deps.db, bearer[1]!);
      if (!key) return reply.code(401).send({ error: 'unauthenticated' });
      request.ctx = {
        user: { id: `key:${key.id}`, email: '', name: key.name },
        tenantId: key.tenantId,
        role: 'agent',
        permissions: new Set(key.permissions as Permission[]),
        actor: 'api_key',
      };
      return undefined;
    }
    const user = await getSession(request.headers);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    const memberships = await membershipsOf(deps.db, user.id);
    const wanted = request.headers['x-tenant-id'];
    const m = wanted ? memberships.find((x) => x.tenantId === wanted) : memberships[0];
    const role = m?.role ?? 'agent';
    request.ctx = {
      user,
      tenantId: m?.tenantId ?? '',
      role,
      permissions: new Set(m ? ROLE_PERMISSIONS[role] : []),
      actor: 'user',
    };
    return undefined;
  };
  const authorize =
    (permission: Permission): Hook =>
    async (request, reply) => {
      const denied = await authenticate(request, reply);
      if (denied !== undefined) return denied;
      if (!request.ctx.tenantId) return reply.code(403).send({ error: 'no_tenant' });
      if (!request.ctx.permissions.has(permission)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      return undefined;
    };
  const guards: Guards = { authenticate, authorize };

  app.get(
    '/api/me',
    {
      preHandler: authenticate,
      config: {
        doc: {
          summary: 'Who am I: user, memberships, permissions',
          access: 'session',
          tag: 'meta',
          errors: ['401 unauthenticated'],
        },
      },
    },
    async (request) => ({
      user: request.ctx.user,
      isAdmin: adminEmails.includes(request.ctx.user.email.toLowerCase()),
      memberships:
        request.ctx.actor === 'api_key' ? [] : await membershipsOf(deps.db, request.ctx.user.id),
      permissions: [...request.ctx.permissions],
      // The desk shows the "switch user" menu only under the dev-auth bypass.
      devMode: Boolean(deps.devUserEmail),
    }),
  );

  /** In-process event bus: internal routes publish, the desk websocket subscribes. */
  const hub = new EventEmitter();
  const secret = deps.internalSecret ?? process.env.INTERNAL_API_SECRET ?? '';
  if (!secret) throw new Error('INTERNAL_API_SECRET is not set');
  const sockets = new DeskSockets();
  const flow = new Flow(deps.db, deps.livekit, hub, (userId, m) => sockets.toUser(userId, m));

  await app.register(adminRoutes, { prefix: '/api/admin', db: deps.db, guards, adminEmails });
  await app.register(deskRoutes, { prefix: '/api/desk', db: deps.db, guards, flow, sockets });
  await app.register(publicRoutes, {
    prefix: '/api/public',
    db: deps.db,
    livekit: deps.livekit,
    flow,
    hub,
  });
  await app.register(internalRoutes, {
    prefix: '/api/internal',
    db: deps.db,
    secret,
    hub,
    flow,
  });
  await registerWs(app, { db: deps.db, getSession, flow, hub, sockets });
  return { app, hub, flow };
}
