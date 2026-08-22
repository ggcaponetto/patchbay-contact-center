/**
 * Postgres connection: a `pg` pool wrapped by Drizzle, with the schema attached so the
 * relational query API is typed. Created once in `index.ts`; tests create their own per
 * suite through `testing.ts`.
 *
 * @see apps/api/src/db/README.md
 * @packageDocumentation
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

/** The Drizzle client type every service and route depends on. */
export type Db = ReturnType<typeof createDb>['db'];

/**
 * Creates a pooled Drizzle client. Call `close()` on shutdown.
 *
 * @param connectionString - Defaults to `DATABASE_URL`.
 * @throws Error when no connection string is available.
 */
export function createDb(connectionString = process.env.DATABASE_URL ?? '') {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}
