/**
 * Process entrypoint of the media worker (`npm run dev:media`): loads `.env.local`,
 * subscribes to the Postgres bus channel and hands every notification to the worker in
 * `worker.ts`, with the LiveKit transport from `transport.ts` and the hold-music loop
 * cache from `loops.ts` (configured files are fetched from `API_ORIGIN`). Nothing else
 * lives here on purpose, so the logic stays testable.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { createLoopCache } from './loops.ts';
import { createTransport } from './transport.ts';
import { createWorker } from './worker.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });

const log = (m: string) => console.log(`media: ${m}`);
const loops = createLoopCache({
  fetch: (url) => fetch(url),
  apiOrigin: process.env.API_ORIGIN ?? 'http://localhost:4000',
  log,
});
const worker = createWorker({
  log,
  connect: createTransport(),
  resolveLoop: (music, style) => loops.get(music, style),
});

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? '' });
await client.connect();
client.on('notification', (n) => {
  if (n.channel === 'cc_bus' && n.payload) void worker.handle(n.payload);
});
await client.query('LISTEN cc_bus');
console.log('media: worker listening for hold-music commands');

const shutdown = async () => {
  await worker.close();
  await client.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
