/**
 * API keys: machine credentials for the public API with an explicit permission set.
 *
 * A key is `ak_` + 32 random bytes (hex). The secret is shown once at creation and only
 * its SHA-256 is stored; lookups hash the presented bearer token. Revoking keeps the row
 * (audit) but the key stops resolving; deleting removes the row for good.
 *
 * @see apps/api/src/services/README.md
 * @packageDocumentation
 */
import type { Permission } from '@cc/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { apiKey } from '../db/schema.ts';

const hashOf = (secret: string) => createHash('sha256').update(secret).digest('hex');

/** What is safe to show in lists: never the hash. */
const publicColumns = {
  id: apiKey.id,
  name: apiKey.name,
  prefix: apiKey.prefix,
  permissions: apiKey.permissions,
  createdAt: apiKey.createdAt,
  lastUsedAt: apiKey.lastUsedAt,
  revokedAt: apiKey.revokedAt,
};

/** Creates a key; the returned `secret` is the only time it is readable. */
export async function createApiKey(
  db: Db,
  tenantId: string,
  name: string,
  permissions: Permission[],
) {
  const secret = `ak_${randomBytes(32).toString('hex')}`;
  const [row] = await db
    .insert(apiKey)
    .values({
      id: randomUUID(),
      tenantId,
      name,
      prefix: secret.slice(0, 12),
      hash: hashOf(secret),
      permissions,
    })
    .returning(publicColumns);
  return { ...row!, secret };
}

/** Every key of the tenant, newest first, revoked ones included. */
export async function listApiKeys(db: Db, tenantId: string) {
  return db
    .select(publicColumns)
    .from(apiKey)
    .where(eq(apiKey.tenantId, tenantId))
    .orderBy(desc(apiKey.createdAt));
}

/** Revokes a key of the tenant. @returns `false` when there is no such active key. */
export async function revokeApiKey(db: Db, tenantId: string, id: string) {
  const rows = await db
    .update(apiKey)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKey.id, id), eq(apiKey.tenantId, tenantId), isNull(apiKey.revokedAt)))
    .returning({ id: apiKey.id });
  return rows.length > 0;
}

/** Deletes a key of the tenant for good (revoked or not). @returns `false` when absent. */
export async function deleteApiKey(db: Db, tenantId: string, id: string) {
  const rows = await db
    .delete(apiKey)
    .where(and(eq(apiKey.id, id), eq(apiKey.tenantId, tenantId)))
    .returning({ id: apiKey.id });
  return rows.length > 0;
}

/**
 * Resolves a presented secret to its active key (and stamps `lastUsedAt`), or `undefined`.
 */
export async function resolveApiKey(db: Db, secret: string) {
  const [row] = await db
    .select()
    .from(apiKey)
    .where(and(eq(apiKey.hash, hashOf(secret)), isNull(apiKey.revokedAt)));
  if (!row) return undefined;
  await db.update(apiKey).set({ lastUsedAt: new Date() }).where(eq(apiKey.id, row.id));
  return row;
}
