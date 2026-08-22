import cors from '@fastify/cors';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { type Auth, type GetSession, type SessionUser, registerAuth } from './auth.ts';
import type { Db } from './db/client.ts';
import { adminRoutes } from './routes/admin.ts';
import { membershipsOf } from './services/tenants.ts';

export type ServerDeps = {
  db: Db;
  /** Real Better Auth instance; tests pass `getSession` instead. */
  auth?: Auth;
  getSession?: GetSession;
  adminEmails?: string[];
};

type Ctx = { user: SessionUser; tenantId: string; role: 'agent' | 'supervisor' };

declare module 'fastify' {
  interface FastifyRequest {
    ctx: Ctx;
  }
}

/** Builds the Fastify instance without listening, so tests can `inject()`. */
export async function buildServer(deps: ServerDeps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  app.decorateRequest('ctx');
  await app.register(cors, { origin: true, credentials: true });
  app.get('/api/health', async () => ({ ok: true }));

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

  await app.register(adminRoutes, { prefix: '/api/admin', db: deps.db, authenticate, adminEmails });
  return app;
}
