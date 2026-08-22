import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof createDb>['db'];

/** Creates a pooled Drizzle client. Call `close()` on shutdown. */
export function createDb(connectionString = process.env.DATABASE_URL ?? '') {
  if (!connectionString) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}
