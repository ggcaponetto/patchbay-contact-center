/**
 * Process entrypoint of the media worker (`npm run dev:media`): loads `.env.local`,
 * subscribes to the Postgres bus channel and hands every notification to the worker in
 * `worker.ts`, with the LiveKit transport from `transport.ts`. Nothing else lives here
 * on purpose, so the logic stays testable.
 */
import dotenv from 'dotenv';
import pg from 'pg';
import { createTransport } from './transport.ts';
import { createWorker } from './worker.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });

const worker = createWorker({ log: (m) => console.log(`media: ${m}`), connect: createTransport() });

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
