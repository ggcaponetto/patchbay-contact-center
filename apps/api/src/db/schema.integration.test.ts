import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, dbAvailable, freshDb } from '../testing.ts';
import type { Db } from './client.ts';
import { session, user } from './schema.ts';

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)('schema in Postgres', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await freshDb());
  });
  afterAll(() => close());

  it('bumps updated_at on every update and cascades sessions from user', async () => {
    const u = await createUser(db, 'ann@example.com');
    const [before] = await db.select().from(user).where(eq(user.id, u.id));
    const sid = randomUUID();
    await db.insert(session).values({
      id: sid,
      token: 'tok',
      userId: u.id,
      expiresAt: new Date(Date.now() + 60_000),
      updatedAt: new Date(0),
    });
    await new Promise((r) => setTimeout(r, 5));
    await db.update(user).set({ name: 'Ann' }).where(eq(user.id, u.id));
    await db.update(session).set({ userAgent: 'test' }).where(eq(session.id, sid));
    const [after] = await db.select().from(user).where(eq(user.id, u.id));
    const [s] = await db.select().from(session).where(eq(session.id, sid));
    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
    expect(s!.updatedAt.getTime()).toBeGreaterThan(0);

    await db.delete(user).where(eq(user.id, u.id));
    expect(await db.select().from(session).where(eq(session.id, sid))).toEqual([]);
  });
});
