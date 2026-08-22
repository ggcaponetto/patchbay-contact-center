import dotenv from 'dotenv';
import { createAuth } from './auth.ts';
import { createDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { createLiveKit } from './livekit.ts';
import { buildServer } from './server.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });

await runMigrations();
const { db } = createDb();
const { app } = await buildServer({ db, livekit: createLiveKit(), auth: createAuth(db) });
await app.listen({ port: Number(process.env.PORT ?? 4000), host: '0.0.0.0' });
