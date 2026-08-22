import cors from '@fastify/cors';
import Fastify from 'fastify';

/** Builds the Fastify instance without listening, so tests can `inject()`. */
export async function buildServer() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  await app.register(cors, { origin: true, credentials: true });
  app.get('/health', async () => ({ ok: true }));
  return app;
}
