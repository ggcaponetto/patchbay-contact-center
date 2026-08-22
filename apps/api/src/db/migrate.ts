import dotenv from 'dotenv';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { createDb } from './client.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });

/** Applies all pending SQL migrations from `apps/api/drizzle`. */
export async function runMigrations(connectionString?: string): Promise<void> {
  const { db, close } = createDb(connectionString);
  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
    });
  } finally {
    await close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runMigrations();
  console.log('migrations applied');
}
