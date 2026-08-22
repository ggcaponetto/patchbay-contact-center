/**
 * Boot sequence of the API, separated from the process entrypoint so it can be tested
 * with fakes. `index.ts` loads `.env.local` and calls {@link start}; nothing else.
 *
 * Order matters and is the whole job of this file:
 *
 * 1. Apply pending SQL migrations so the schema is always current before any query runs.
 * 2. Open the Postgres pool and create the real LiveKit client.
 * 3. Pick the auth strategy: `DEV_USER_EMAIL` (dev bypass, never in production; seeds the
 *    demo team unless `DEV_DEMO_TEAM=false`) or Better Auth with Google.
 * 4. `buildServer` wires everything together; then listen on `PORT` (default 4000).
 *
 * @see apps/api/README.md
 * @packageDocumentation
 */
import { createAuth } from './auth.ts';
import { createDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { createLiveKit } from './livekit.ts';
import { buildServer } from './server.ts';

/** The factories {@link start} composes; production uses the real ones, tests pass fakes. */
export type BootDeps = {
  runMigrations: typeof runMigrations;
  createDb: typeof createDb;
  createLiveKit: typeof createLiveKit;
  createAuth: typeof createAuth;
  buildServer: typeof buildServer;
};

const realDeps: BootDeps = { runMigrations, createDb, createLiveKit, createAuth, buildServer };

/**
 * Migrates, wires and starts listening. Resolves once the server accepts connections.
 *
 * @param env - Environment to read `NODE_ENV`, `DEV_USER_EMAIL`, `DEV_DEMO_TEAM` and `PORT` from.
 * @param deps - See {@link BootDeps}; defaults to the real implementations.
 * @returns The listening Fastify app, so callers (and tests) can close it.
 */
export async function start(env: NodeJS.ProcessEnv = process.env, deps: BootDeps = realDeps) {
  await deps.runMigrations();
  const { db } = deps.createDb();
  // The bypass is only honoured outside production, even if the variable is set.
  const devUser = env.NODE_ENV !== 'production' ? env.DEV_USER_EMAIL : undefined;
  const { app } = await deps.buildServer({
    db,
    livekit: deps.createLiveKit(),
    ...(devUser
      ? { devUserEmail: devUser, devDemoTeam: env.DEV_DEMO_TEAM !== 'false' }
      : { auth: deps.createAuth(db) }),
  });
  const port = Number(env.PORT ?? 4000);
  try {
    await app.listen({ port, host: '0.0.0.0' });
  } catch (err) {
    // A taken port (e.g. NoMachine on 4000) is the most common first-run failure.
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      app.log.fatal(
        `Port ${port} is already in use. Set PORT (API), API_PORT (web proxy) and API_ORIGIN (agent) in .env.local to a free port such as 4100.`,
      );
    }
    throw err;
  }
  return app;
}
