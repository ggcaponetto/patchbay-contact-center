/**
 * Authentication: Better Auth (Google OAuth) plus a development bypass.
 *
 * Every authenticated route and the websocket go through one function type,
 * {@link GetSession}: "given request headers, who is this?". `server.ts` obtains it in one
 * of two ways:
 *
 * - {@link registerAuth}: mounts the real Better Auth handler on `/api/auth/*` (sign-in,
 *   callback, session, sign-out) and resolves sessions from the cookie it sets.
 * - {@link devAuth}: no Google, no cookies; every request is the configured dev user.
 *
 * Tests bypass both and hand `buildServer` their own resolver.
 *
 * First-login bootstrap: Better Auth's `user.create.after` hook calls
 * `bootstrapUser` (services/tenants.ts), which turns pending invites into memberships and
 * gives `ADMIN_EMAILS` users a tenant of their own.
 *
 * @see apps/api/src/README.md
 * @packageDocumentation
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db/client.ts';
import * as schema from './db/schema.ts';
import { seedDemoTeam } from './services/demo.ts';
import { bootstrapUser, membershipsOf } from './services/tenants.ts';

/** The subset of the user row the rest of the API needs. Stored on `request.ctx.user`. */
export type SessionUser = { id: string; email: string; name: string };

/**
 * Resolves the signed-in user from raw request headers (cookie), or `null` when there is
 * no valid session. Works for HTTP requests and websocket upgrades alike.
 */
export type GetSession = (headers: Record<string, unknown>) => Promise<SessionUser | null>;

/**
 * Better Auth instance: Google OAuth, Drizzle/Postgres, first-login bootstrap.
 *
 * Reads `WEB_ORIGIN`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
 * `ADMIN_EMAILS` from the environment. The base URL is the *web* origin because the web
 * app proxies `/api` to this server, so browsers only ever talk to `WEB_ORIGIN`. Better
 * Auth derives the OAuth redirect URI from it (`<baseURL>/api/auth/callback/google`); the
 * Google OAuth client must list that exact URI.
 *
 * @param db - Drizzle client; Better Auth stores `user`, `session`, `account` and
 *   `verification` rows through it (tables defined in `db/schema.ts`).
 * @returns The configured Better Auth instance (`auth.handler`, `auth.api.getSession`).
 */
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
          // Runs once per new user, right after Google sign-in created the row.
          after: async (u) => {
            await bootstrapUser(db, { id: u.id, email: u.email, name: u.name }, adminEmails);
          },
        },
      },
    },
  });
}

/** Type of the object returned by {@link createAuth}. */
export type Auth = ReturnType<typeof createAuth>;

/**
 * Mounts the Better Auth handler on `/api/auth/*` and returns a session resolver.
 *
 * Better Auth speaks the Fetch API (`Request` / `Response`), Fastify does not, so the
 * route handler translates: it rebuilds a `Request` from the Fastify request (URL, method,
 * headers, JSON body), lets Better Auth handle it, then copies status, headers (including
 * `set-cookie`) and body back onto the reply.
 *
 * @param app - Fastify instance to mount the route on.
 * @param auth - Instance from {@link createAuth}.
 * @returns A {@link GetSession} that asks Better Auth to validate the session cookie.
 */
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

/** Name of the cookie that lets a request pick another dev user (see `devAuth`). */
const DEV_USER_COOKIE = 'cc_dev_user';

/** Reads one cookie out of a raw `cookie` header without a cookie library. */
function cookieValue(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers.cookie;
  if (typeof raw !== 'string') return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * Development-only bypass: every request is signed in as `email` (created and
 * bootstrapped on first use), and the web client's session probe is answered
 * locally. Never enabled in production.
 *
 * A request may pick a different dev user with the `cc_dev_user=<email>` cookie
 * (`DEV_USER_COOKIE`); that user is created and bootstrapped on first use too, which
 * is how the end-to-end suite plays several agents and supervisors (and exercises invites)
 * in one browser. The cookie rides on HTTP and websocket upgrades alike.
 *
 * The desk switches person through `GET /api/auth/dev-users` (everyone in the database)
 * and `POST /api/auth/dev-switch { email }` (sets the cookie); `POST /api/auth/sign-out`
 * clears it, i.e. goes back to the default user. With `demoTeam`, the default user's
 * first contact center is seeded with a demo supervisor and agents (`services/demo.ts`).
 *
 * Why it is safe only in development: anyone who can reach the port can be any user.
 * `boot.ts` only passes `DEV_USER_EMAIL` when `NODE_ENV !== 'production'`. The
 * `get-session` / `sign-out` stubs exist so the web desk's Better Auth client keeps
 * working unchanged.
 *
 * @param app - Fastify instance to mount the stub auth routes on.
 * @param db - Used to find or create the user rows.
 * @param email - The user a request without the cookie runs as.
 * @param adminEmails - Forwarded to `bootstrapUser` so dev users can get their own tenant.
 * @param demoTeam - Seed the demo team into the default user's tenant (default `false`).
 * @returns A {@link GetSession} resolving the default or cookie-selected dev user.
 */
export async function devAuth(
  app: FastifyInstance,
  db: Db,
  email: string,
  adminEmails: string[],
  demoTeam = false,
): Promise<GetSession> {
  const { eq } = await import('drizzle-orm');
  const { randomUUID } = await import('node:crypto');
  const users = new Map<string, SessionUser>();
  const resolve = async (wanted: string): Promise<SessionUser> => {
    const cached = users.get(wanted);
    if (cached) return cached;
    let [row] = await db.select().from(schema.user).where(eq(schema.user.email, wanted));
    if (!row) {
      [row] = await db
        .insert(schema.user)
        .values({
          id: randomUUID(),
          email: wanted,
          name: wanted.split('@')[0] ?? wanted,
          updatedAt: new Date(),
        })
        .returning();
      await bootstrapUser(db, { id: row!.id, email: wanted, name: row!.name }, adminEmails);
    }
    const user: SessionUser = { id: row!.id, email: wanted, name: row!.name };
    users.set(wanted, user);
    return user;
  };
  const me = await resolve(email);
  if (demoTeam) {
    const [home] = await membershipsOf(db, me.id);
    if (home) {
      const created = await seedDemoTeam(db, home.tenantId);
      if (created) app.log.info(`demo team: ${created} user(s) added to ${home.tenantName}`);
    }
  }
  const getSession: GetSession = (headers) =>
    resolve(cookieValue(headers, DEV_USER_COOKIE)?.trim().toLowerCase() || email);
  const cookie = (value: string, maxAge?: number) =>
    `${DEV_USER_COOKIE}=${encodeURIComponent(value)}; Path=/; SameSite=Lax` +
    (maxAge === undefined ? '' : `; Max-Age=${maxAge}`);
  app.get('/api/auth/get-session', async (request) => {
    const user = await getSession(request.headers);
    return {
      session: { id: 'dev', userId: user!.id, expiresAt: new Date(Date.now() + 864e5) },
      user,
    };
  });
  app.post('/api/auth/sign-out', async (_request, reply) => {
    reply.header('set-cookie', cookie('', 0));
    return { success: true };
  });
  app.get('/api/auth/dev-users', async (request) => ({
    current: (await getSession(request.headers))!.email,
    users: await db
      .select({ id: schema.user.id, email: schema.user.email, name: schema.user.name })
      .from(schema.user)
      .orderBy(schema.user.email),
  }));
  app.post<{ Body: { email?: string } }>('/api/auth/dev-switch', async (request, reply) => {
    const wanted = String(request.body?.email ?? '')
      .trim()
      .toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(wanted)) return reply.code(400).send({ error: 'invalid_email' });
    const user = await resolve(wanted);
    reply.header('set-cookie', cookie(wanted));
    return user;
  });
  app.log.warn(
    `DEV_USER_EMAIL set: every request runs as ${email} (or the ${DEV_USER_COOKIE} cookie)`,
  );
  return getSession;
}
