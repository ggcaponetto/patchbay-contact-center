/**
 * Demo team for local development: when the API runs with the dev-auth bypass
 * (`DEV_USER_EMAIL`, see `auth.ts`) and `DEV_DEMO_TEAM` is not `false`, the default dev
 * user's contact center gets a supervisor and three agents so the desk can be used as
 * several people at once (switch user in the app bar, one identity per browser profile).
 *
 * Idempotent: users are found by email, memberships come from the same invite +
 * `bootstrapUser` path a real first sign-in takes, queue membership is merged, never
 * replaced. Safe to run at every boot.
 *
 * @see apps/api/README.md
 * @packageDocumentation
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import * as schema from '../db/schema.ts';
import {
  bootstrapUser,
  createInvite,
  createQueue,
  listQueues,
  setQueueMembers,
} from './tenants.ts';

/** The people seeded by {@link seedDemoTeam}. */
export const DEMO_TEAM = [
  { email: 'sam@patchbay.dev', name: 'Sam', role: 'supervisor', queues: ['support'] },
  { email: 'alice@patchbay.dev', name: 'Alice', role: 'agent', queues: ['support', 'sales'] },
  { email: 'bob@patchbay.dev', name: 'Bob', role: 'agent', queues: ['support', 'sales'] },
  { email: 'carol@patchbay.dev', name: 'Carol', role: 'agent', queues: ['support'] },
] as const;

/**
 * Makes sure the demo team exists in `tenantId`: users, memberships and the `support` /
 * `sales` queue memberships.
 *
 * @returns The number of users created this time (0 when everything was there already).
 */
export async function seedDemoTeam(db: Db, tenantId: string): Promise<number> {
  let created = 0;
  const ids = new Map<string, string>();
  for (const person of DEMO_TEAM) {
    let [row] = await db.select().from(schema.user).where(eq(schema.user.email, person.email));
    if (!row) {
      await createInvite(db, tenantId, person.email, person.role);
      [row] = await db
        .insert(schema.user)
        .values({ id: randomUUID(), email: person.email, name: person.name, updatedAt: new Date() })
        .returning();
      await bootstrapUser(db, { id: row!.id, email: person.email, name: person.name }, []);
      created++;
    }
    ids.set(person.email, row!.id);
  }
  const queues = new Map((await listQueues(db, tenantId)).map((q) => [q.key, q]));
  for (const key of ['support', 'sales']) {
    if (queues.has(key)) continue;
    const q = await createQueue(db, tenantId, key, key === 'sales' ? 'Sales' : 'Support');
    queues.set(key, { ...q, memberIds: [] });
  }
  for (const [key, q] of queues) {
    const wanted = DEMO_TEAM.filter((p) => (p.queues as readonly string[]).includes(key)).map((p) =>
      ids.get(p.email)!,
    );
    const merged = [...new Set([...q.memberIds, ...wanted])];
    if (merged.length !== q.memberIds.length) await setQueueMembers(db, tenantId, q.id, merged);
  }
  return created;
}
