/**
 * Process entrypoint of the API (`npm run dev:api` / `node src/index.ts`).
 *
 * Boot order matters and is the whole job of this file:
 *
 * 1. Load `.env.local` (the one in `apps/api`, then the repo root).
 * 2. Apply pending SQL migrations so the schema is always current before any query runs.
 * 3. Open the Postgres pool and create the real LiveKit client.
 * 4. Pick the auth strategy: `DEV_USER_EMAIL` (dev bypass, never in production) or
 *    Better Auth with Google.
 * 5. {@link buildServer} wires everything together; then listen on `PORT` (default 4000).
 *
 * Nothing else lives here on purpose: `buildServer` is what tests call, with fakes
 * injected instead of the objects created in this file.
 *
 * @see apps/api/README.md
 * @packageDocumentation
 */
import dotenv from 'dotenv';
import { createAuth } from './auth.ts';
import { createDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { createLiveKit } from './livekit.ts';
import { buildServer } from './server.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });

await runMigrations();
const { db } = createDb();
// The bypass is only honoured outside production, even if the variable is set.
const devUser = process.env.NODE_ENV !== 'production' ? process.env.DEV_USER_EMAIL : undefined;
const { app } = await buildServer({
  db,
  livekit: createLiveKit(),
  ...(devUser ? { devUserEmail: devUser } : { auth: createAuth(db) }),
});
await app.listen({ port: Number(process.env.PORT ?? 4000), host: '0.0.0.0' });
