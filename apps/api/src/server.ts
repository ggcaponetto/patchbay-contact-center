import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Auth, type GetSession, type SessionUser, registerAuth } from './auth.ts';
import type { Db } from './db/client.ts';
import { Flow } from './flow.ts';
import type { LiveKit } from './livekit.ts';
import { adminRoutes } from './routes/admin.ts';
import { deskRoutes } from './routes/desk.ts';
import { internalRoutes } from './routes/internal.ts';
import { publicRoutes } from './routes/public.ts';
import { membershipsOf } from './services/tenants.ts';
import { DeskSockets, registerWs } from './ws.ts';

export type ServerDeps = {
  db: Db;
  livekit: LiveKit;
  /** Real Better Auth instance; tests pass `getSession` instead. */
  auth?: Auth;
  getSession?: GetSession;
  adminEmails?: string[];
  internalSecret?: string;
};

type Ctx = { user: SessionUser; tenantId: string; role: 'agent' | 'supervisor' };

declare module 'fastify' {
  interface FastifyRequest {
    ctx: Ctx;
  }
}

/** Builds the Fastify instance (not listening, so tests can `inject()`) and its event hub. */
export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.decorateRequest('ctx');
  await app.register(cors, { origin: true, credentials: true });
  app.get('/api/health', async () => ({ ok: true }));
  // Serve the built call button so websites can load it from the API origin.
  const embedDist = fileURLToPath(new URL('../../embed/dist/', import.meta.url));
  if (existsSync(embedDist)) {
    await app.register(fastifyStatic, { root: embedDist, prefix: '/embed/', decorateReply: false });
  }

  const getSession = deps.auth ? registerAuth(app, deps.auth) : deps.getSession;
  if (!getSession) throw new Error('buildServer needs `auth` or `getSession`');
  const adminEmails = (deps.adminEmails ?? (process.env.ADMIN_EMAILS ?? '').split(','))
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  /** Resolves the signed-in user and the tenant selected by `x-tenant-id` (or the first one). */
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
