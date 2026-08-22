import { TenantSettings, defaultTenantSettings } from '@cc/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { embedKey, invite, membership, queue, queueMember, tenant, user } from '../db/schema.ts';

export type Role = 'agent' | 'supervisor';

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'tenant';

/** Creates a tenant with a default `support` queue and makes `userId` its supervisor. */
export async function createTenant(db: Db, name: string, userId: string) {
  const id = randomUUID();
  const [row] = await db
    .insert(tenant)
    .values({
      id,
      name,
      slug: `${slugify(name)}-${id.slice(0, 6)}`,
      settings: defaultTenantSettings(),
    })
    .returning();
  await db
    .insert(queue)
    .values({ id: randomUUID(), tenantId: id, key: 'support', name: 'Support' });
  await db
    .insert(membership)
    .values({ id: randomUUID(), userId, tenantId: id, role: 'supervisor' });
  return row!;
}

/**
 * Runs on first sign-in. Admin emails get a tenant of their own when none exists
 * for them; pending invites for the email become memberships.
 */
export async function bootstrapUser(
  db: Db,
  u: { id: string; email: string; name: string },
  adminEmails: string[],
) {
  const email = u.email.toLowerCase();
  const pending = await db
    .select()
    .from(invite)
    .where(and(eq(invite.email, email), isNull(invite.acceptedAt)));
  for (const inv of pending) {
    await db
      .insert(membership)
      .values({ id: randomUUID(), userId: u.id, tenantId: inv.tenantId, role: inv.role })
      .onConflictDoNothing();
    await db.update(invite).set({ acceptedAt: new Date() }).where(eq(invite.id, inv.id));
  }
  const existing = await db.select().from(membership).where(eq(membership.userId, u.id));
  if (existing.length === 0 && adminEmails.map((e) => e.trim().toLowerCase()).includes(email)) {
    await createTenant(db, `${u.name || email}'s contact center`, u.id);
  }
}

export async function membershipsOf(db: Db, userId: string) {
  return db
    .select({
      tenantId: membership.tenantId,
      role: membership.role,
      tenantName: tenant.name,
      slug: tenant.slug,
    })
    .from(membership)
    .innerJoin(tenant, eq(tenant.id, membership.tenantId))
    .where(eq(membership.userId, userId));
}

export async function getTenant(db: Db, tenantId: string) {
  const [row] = await db.select().from(tenant).where(eq(tenant.id, tenantId));
  return row ? { ...row, settings: TenantSettings.parse(row.settings) } : undefined;
}

export async function updateSettings(db: Db, tenantId: string, patch: unknown) {
  const current = await getTenant(db, tenantId);
  if (!current) return undefined;
  const settings = TenantSettings.parse({ ...current.settings, ...(patch as object) });
  await db.update(tenant).set({ settings }).where(eq(tenant.id, tenantId));
  return settings;
}

export async function listMembers(db: Db, tenantId: string) {
  return db
    .select({ userId: user.id, name: user.name, email: user.email, role: membership.role })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.tenantId, tenantId));
}

export async function createInvite(db: Db, tenantId: string, email: string, role: Role) {
  const [row] = await db
    .insert(invite)
    .values({ id: randomUUID(), tenantId, email: email.toLowerCase(), role })
    .onConflictDoUpdate({
      target: [invite.tenantId, invite.email],
      set: { role, acceptedAt: null },
    })
    .returning();
  return row!;
}

export async function listInvites(db: Db, tenantId: string) {
  return db.select().from(invite).where(eq(invite.tenantId, tenantId));
}

export async function listQueues(db: Db, tenantId: string) {
  const rows = await db.select().from(queue).where(eq(queue.tenantId, tenantId));
  const members = await db
    .select({ queueId: queueMember.queueId, userId: queueMember.userId })
    .from(queueMember)
    .innerJoin(queue, eq(queue.id, queueMember.queueId))
    .where(eq(queue.tenantId, tenantId));
  return rows.map((q) => ({
    ...q,
    memberIds: members.filter((m) => m.queueId === q.id).map((m) => m.userId),
  }));
}

export async function createQueue(db: Db, tenantId: string, key: string, name: string) {
  const [row] = await db
    .insert(queue)
    .values({ id: randomUUID(), tenantId, key: slugify(key), name })
    .returning();
  return row!;
}

export async function setQueueMembers(
  db: Db,
  tenantId: string,
  queueId: string,
  userIds: string[],
) {
  const [q] = await db
    .select()
    .from(queue)
    .where(and(eq(queue.id, queueId), eq(queue.tenantId, tenantId)));
  if (!q) return false;
  await db.delete(queueMember).where(eq(queueMember.queueId, queueId));
  if (userIds.length > 0) {
    await db.insert(queueMember).values(userIds.map((userId) => ({ queueId, userId })));
  }
  return true;
}

export async function createEmbedKey(
  db: Db,
  tenantId: string,
  label: string,
  allowedOrigins: string[],
) {
  const [row] = await db
    .insert(embedKey)
    .values({
      id: randomUUID(),
      tenantId,
      label,
      allowedOrigins,
      publicKey: `pk_${randomBytes(16).toString('hex')}`,
    })
    .returning();
  return row!;
}

export async function listEmbedKeys(db: Db, tenantId: string) {
  return db.select().from(embedKey).where(eq(embedKey.tenantId, tenantId));
}

export async function deleteEmbedKey(db: Db, tenantId: string, id: string) {
  const rows = await db
    .delete(embedKey)
    .where(and(eq(embedKey.id, id), eq(embedKey.tenantId, tenantId)))
    .returning();
  return rows.length > 0;
}

/** Resolves a public embed key to its tenant and the queue to use. */
export async function resolveEmbedKey(db: Db, publicKey: string, queueKey: string) {
  const [k] = await db.select().from(embedKey).where(eq(embedKey.publicKey, publicKey));
  if (!k) return undefined;
  const [q] = await db
    .select()
    .from(queue)
    .where(and(eq(queue.tenantId, k.tenantId), eq(queue.key, queueKey)));
  const t = await getTenant(db, k.tenantId);
  if (!q || !t) return undefined;
  return { key: k, queue: q, tenant: t };
}

/** Origin check for embed requests: empty allow-list means any origin. */
export const originAllowed = (allowed: string[], origin: string | undefined): boolean =>
  allowed.length === 0 || (origin !== undefined && allowed.includes(origin));
