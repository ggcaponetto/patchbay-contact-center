import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db/client.ts';
import * as schema from './db/schema.ts';
import { bootstrapUser } from './services/tenants.ts';

export type SessionUser = { id: string; email: string; name: string };
export type GetSession = (headers: Record<string, unknown>) => Promise<SessionUser | null>;

/** Better Auth instance: Google OAuth, Drizzle/Postgres, first-login bootstrap. */
export function createAuth(db: Db) {
  const adminEmails = (process.env.ADMIN_EMAILS ?? '').split(',').filter(Boolean);
  return betterAuth({
    // The web app proxies /api to this server, so the auth base URL is the web origin.
    baseURL: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    basePath: '/api/auth',
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: [process.env.WEB_ORIGIN ?? 'http://localhost:3000'],
    database: drizzleAdapter(db, { provider: 'pg', schema }),
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID ?? '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (u) => {
            await bootstrapUser(db, { id: u.id, email: u.email, name: u.name }, adminEmails);
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Mounts the Better Auth handler on `/api/auth/*` and returns a session resolver. */
export function registerAuth(app: FastifyInstance, auth: Auth): GetSession {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = fromNodeHeaders(request.headers);
      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(req);
      reply.status(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? await response.text() : null);
    },
  });
  return async (headers) => {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(headers as Record<string, string>),
    });
    return session
      ? { id: session.user.id, email: session.user.email, name: session.user.name }
      : null;
  };
}

/**
 * Development-only bypass: every request is signed in as `email` (created and
 * bootstrapped on first use), and the web client's session probe is answered
 * locally. Never enabled in production.
 */
export async function devAuth(
  app: FastifyInstance,
  db: Db,
  email: string,
  adminEmails: string[],
): Promise<GetSession> {
  const { eq } = await import('drizzle-orm');
  const { randomUUID } = await import('node:crypto');
  let [row] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  if (!row) {
    [row] = await db
      .insert(schema.user)
      .values({
        id: randomUUID(),
        email,
        name: email.split('@')[0] ?? email,
        updatedAt: new Date(),
      })
      .returning();
    await bootstrapUser(db, { id: row!.id, email, name: row!.name }, adminEmails);
  }
  const user: SessionUser = { id: row!.id, email, name: row!.name };
  app.get('/api/auth/get-session', async () => ({
    session: { id: 'dev', userId: user.id, expiresAt: new Date(Date.now() + 864e5) },
    user,
  }));
  app.post('/api/auth/sign-out', async () => ({ success: true }));
  app.log.warn(`DEV_USER_EMAIL set: every request runs as ${email}`);
  return async () => user;
}
