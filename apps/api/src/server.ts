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
import { adminRoutes } from './routes/admin.ts';
import { deskRoutes } from './routes/desk.ts';
import { internalRoutes } from './routes/internal.ts';
import { publicRoutes } from './routes/public.ts';
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
  /** Emails allowed to create tenants; defaults to the `ADMIN_EMAILS` env var. */
  adminEmails?: string[];
  /** Shared secret for `/api/internal`; defaults to the `INTERNAL_API_SECRET` env var. */
  internalSecret?: string;
};

/**
 * Per-request context filled by the `authenticate` preHandler.
 *
 * `tenantId` is `''` when the user has no membership at all; route hooks turn that into a
 * 403 (`no_tenant`). `role` is the user's role in that tenant.
 */
type Ctx = { user: SessionUser; tenantId: string; role: 'agent' | 'supervisor' };

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
  app.get('/api/health', async () => ({ ok: true }));
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
      ? await devAuth(app, deps.db, deps.devUserEmail, adminEmails)
      : deps.getSession;
  if (!getSession) throw new Error('buildServer needs `auth`, `devUserEmail` or `getSession`');

  /**
   * Resolves the signed-in user and the tenant selected by `x-tenant-id` (or the first one).
   * Replies 401 when there is no session; otherwise fills `request.ctx` and returns
   * `undefined` so the route handler runs. Route files wrap this to add role checks.
   */
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await getSession(request.headers);
    if (!user) return reply.code(401).send({ error: 'unauthenticated' });
    const memberships = await membershipsOf(deps.db, user.id);
    const wanted = request.headers['x-tenant-id'];
    const m = wanted ? memberships.find((x) => x.tenantId === wanted) : memberships[0];
    request.ctx = { user, tenantId: m?.tenantId ?? '', role: m?.role ?? 'agent' };
    return undefined;
  };

  app.get('/api/me', { preHandler: authenticate }, async (request) => ({
    user: request.ctx.user,
    isAdmin: adminEmails.includes(request.ctx.user.email.toLowerCase()),
    memberships: await membershipsOf(deps.db, request.ctx.user.id),
  }));

  /** In-process event bus: internal routes publish, the desk websocket subscribes. */
  const hub = new EventEmitter();
  const secret = deps.internalSecret ?? process.env.INTERNAL_API_SECRET ?? '';
  if (!secret) throw new Error('INTERNAL_API_SECRET is not set');
  const sockets = new DeskSockets();
  const flow = new Flow(deps.db, deps.livekit, hub, (userId, m) => sockets.toUser(userId, m));

  await app.register(adminRoutes, { prefix: '/api/admin', db: deps.db, authenticate, adminEmails });
  await app.register(deskRoutes, { prefix: '/api/desk', db: deps.db, authenticate, flow });
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
