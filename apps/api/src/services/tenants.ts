/**
 * Tenant domain: tenants, memberships, invites, queues, embed keys.
 *
 * Plain async functions over the Drizzle client; no Fastify, no LiveKit. Routes in
 * `routes/admin.ts` call them almost one-to-one, `auth.ts` uses `bootstrapUser` on first
 * sign-in, `routes/public.ts` uses `resolveEmbedKey` / `originAllowed`, and `ws.ts` uses
 * `membershipsOf`.
 *
 * Every function takes the tenant id explicitly and scopes its query to it, so a
 * supervisor can never reach another tenant's rows by guessing ids.
 *
 * @see apps/api/src/services/README.md
 * @packageDocumentation
 */
import {
  type QueueConfig,
  TenantSettings,
  type UserSkill,
  defaultTenantSettings,
} from '@cc/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import {
  call,
  embedKey,
  invite,
  membership,
  queue,
  queueMember,
  tenant,
  user,
  userSkill,
} from '../db/schema.ts';

/** Role of a user inside one tenant. Same values as `MembershipRole` in `@cc/shared`. */
export type Role = 'agent' | 'supervisor';

/**
 * Lower-cases and replaces every non-alphanumeric run with `-`; `'tenant'` if nothing is left.
 * Used for tenant slugs and queue keys.
 *
 * @example
 * ```ts
 * slugify('VIP Sales!'); // 'vip-sales'
 * ```
 */
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'tenant';

/**
 * Creates a tenant with a default `support` queue and makes `userId` its supervisor.
 *
 * The slug is `<slugified name>-<first 6 chars of the id>` so two tenants with the same
 * name do not collide. Settings start as `defaultTenantSettings()`.
 *
 * @returns The inserted tenant row.
 */
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
  const queueId = randomUUID();
  await db.insert(queue).values({ id: queueId, tenantId: id, key: 'support', name: 'Support' });
  await db
    .insert(membership)
    .values({ id: randomUUID(), userId, tenantId: id, role: 'supervisor' });
  // The creator can take calls right away; more members are managed in Settings.
  await db.insert(queueMember).values({ queueId, userId });
  return row!;
}

/**
 * Runs on first sign-in. Admin emails get a tenant of their own when none exists
 * for them; pending invites for the email become memberships.
 *
 * Rules, in order:
 * 1. Every open invite (`acceptedAt IS NULL`) for the email becomes a membership with the
 *    invited role and is marked accepted. `onConflictDoNothing` makes re-runs harmless.
 * 2. If the user still has no membership and the email is in `adminEmails`, a personal
 *    tenant is created with the user as supervisor.
 *
 * Idempotent: calling it again for the same user changes nothing.
 *
 * @param adminEmails - Raw values from `ADMIN_EMAILS`; trimmed and lower-cased here.
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

/** Tenants the user belongs to, with role, name and slug (what `/api/me` returns). */
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

/**
 * The tenant row with its `settings` parsed through `TenantSettings`, so missing keys
 * get their defaults and callers never see raw JSON.
 */
export async function getTenant(db: Db, tenantId: string) {
  const [row] = await db.select().from(tenant).where(eq(tenant.id, tenantId));
  return row ? { ...row, settings: TenantSettings.parse(row.settings) } : undefined;
}

/**
 * Shallow-merges `patch` over the current settings, validates the result and stores it.
 *
 * @param patch - Already validated by the route (`TenantSettings.partial()`); nested
 *   objects such as `aiAgent` are replaced whole, not deep-merged.
 * @returns The new settings, or `undefined` for an unknown tenant.
 * @throws ZodError if the merged object is invalid.
 */
export async function updateSettings(db: Db, tenantId: string, patch: unknown) {
  const current = await getTenant(db, tenantId);
  if (!current) return undefined;
  const settings = TenantSettings.parse({ ...current.settings, ...(patch as object) });
  await db.update(tenant).set({ settings }).where(eq(tenant.id, tenantId));
  return settings;
}

/** Members of the tenant with their user details and role. */
export async function listMembers(db: Db, tenantId: string) {
  return db
    .select({ userId: user.id, name: user.name, email: user.email, role: membership.role })
    .from(membership)
    .innerJoin(user, eq(user.id, membership.userId))
    .where(eq(membership.tenantId, tenantId));
}

/**
 * Creates or refreshes an invite. One invite per (tenant, email): inviting again
 * updates the role and re-opens it (`acceptedAt = null`).
 *
 * @returns The invite row.
 */
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

/** All invites of the tenant, accepted or not. */
export async function listInvites(db: Db, tenantId: string) {
  return db.select().from(invite).where(eq(invite.tenantId, tenantId));
}

/** Queues of the tenant, each with `memberIds` (user ids). */
export async function listQueues(db: Db, tenantId: string) {
  const rows = await db
    .select()
    .from(queue)
    .where(and(eq(queue.tenantId, tenantId), isNull(queue.archivedAt)));
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

/**
 * Creates a queue; `key` is slugified. Keys are unique per tenant.
 * @throws on a duplicate key (unique index `queue_tenant_key_uidx`).
 */
export async function createQueue(db: Db, tenantId: string, key: string, name: string) {
  const [row] = await db
    .insert(queue)
    .values({ id: randomUUID(), tenantId, key: slugify(key), name })
    .returning();
  return row!;
}

/**
 * Replaces the member list of a queue (delete all, insert given).
 *
 * @returns `false` when the queue does not belong to the tenant.
 */
/** Stores the routing configuration of a queue (validated `QueueConfig`). */
export async function setQueueConfig(
  db: Db,
  tenantId: string,
  queueId: string,
  config: QueueConfig,
): Promise<boolean> {
  const rows = await db
    .update(queue)
    .set({ config })
    .where(and(eq(queue.id, queueId), eq(queue.tenantId, tenantId)))
    .returning({ id: queue.id });
  return rows.length > 0;
}

/** Skills a member holds in this tenant. */
export async function skillsOf(db: Db, tenantId: string, userId: string): Promise<UserSkill[]> {
  const rows = await db
    .select({ skill: userSkill.skill, proficiency: userSkill.proficiency })
    .from(userSkill)
    .where(and(eq(userSkill.tenantId, tenantId), eq(userSkill.userId, userId)));
  return rows;
}

/** Replaces a member's skill set (reskilling applies to the next routing decision). */
export async function setSkills(
  db: Db,
  tenantId: string,
  userId: string,
  skills: UserSkill[],
): Promise<void> {
  await db
    .delete(userSkill)
    .where(and(eq(userSkill.tenantId, tenantId), eq(userSkill.userId, userId)));
  if (skills.length > 0) {
    await db
      .insert(userSkill)
      .values(
        skills.map((s) => ({ tenantId, userId, skill: s.skill, proficiency: s.proficiency })),
      );
  }
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

/**
 * "Deletes" a queue: a queue no call ever went through is removed (members cascade);
 * one with call history is archived instead � gone from listings, routing and embeds,
 * but `call.queue_id` keeps pointing at it so history shows the queue name. The last
 * active queue of a tenant cannot be deleted.
 *
 * @returns `not_found`, `last_queue`, or the outcome with `archived` telling which.
 */
export async function deleteQueue(
  db: Db,
  tenantId: string,
  queueId: string,
): Promise<'not_found' | 'last_queue' | { archived: boolean }> {
  const active = await db
    .select({ id: queue.id })
    .from(queue)
    .where(and(eq(queue.tenantId, tenantId), isNull(queue.archivedAt)));
  if (!active.some((q) => q.id === queueId)) return 'not_found';
  if (active.length === 1) return 'last_queue';
  const [used] = await db
    .select({ id: call.id })
    .from(call)
    .where(eq(call.queueId, queueId))
    .limit(1);
  if (!used) {
    await db.delete(queue).where(eq(queue.id, queueId));
    return { archived: false };
  }
  await db.delete(queueMember).where(eq(queueMember.queueId, queueId));
  await db.update(queue).set({ archivedAt: new Date() }).where(eq(queue.id, queueId));
  return { archived: true };
}

/**
 * Creates an embed key with a random public key (`pk_` + 32 hex chars).
 * The public key is not secret: it is embedded in third-party websites.
 */
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

/** Embed keys of the tenant. */
export async function listEmbedKeys(db: Db, tenantId: string) {
  return db.select().from(embedKey).where(eq(embedKey.tenantId, tenantId));
}

/**
 * Deletes an embed key of the tenant.
 * @returns `false` when nothing matched.
 */
export async function deleteEmbedKey(db: Db, tenantId: string, id: string) {
  const rows = await db
    .delete(embedKey)
    .where(and(eq(embedKey.id, id), eq(embedKey.tenantId, tenantId)))
    .returning();
  return rows.length > 0;
}

/**
 * Resolves a public embed key to its tenant and the queue to use.
 *
 * @param publicKey - The `pk_...` value from the embed snippet.
 * @param queueKey - Queue key requested by the embed (defaults to `support` in the route).
 * @returns `{ key, queue, tenant }` (tenant settings parsed) or `undefined` if the key is
 *   unknown or the queue does not exist in that tenant.
 */
export async function resolveEmbedKey(db: Db, publicKey: string, queueKey: string) {
  const [k] = await db.select().from(embedKey).where(eq(embedKey.publicKey, publicKey));
  if (!k) return undefined;
  const [q] = await db
    .select()
    .from(queue)
    .where(and(eq(queue.tenantId, k.tenantId), eq(queue.key, queueKey), isNull(queue.archivedAt)));
  const t = await getTenant(db, k.tenantId);
  if (!q || !t) return undefined;
  return { key: k, queue: q, tenant: t };
}

/**
 * Origin check for embed requests: empty allow-list means any origin.
 * Compares the raw `Origin` header, so entries must be exact origins (scheme + host + port).
 */
export const originAllowed = (allowed: string[], origin: string | undefined): boolean =>
  allowed.length === 0 || (origin !== undefined && allowed.includes(origin));
