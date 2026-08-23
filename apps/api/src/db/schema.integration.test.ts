import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant } from '../services/tenants.ts';
import { createUser, dbAvailable, freshDb } from '../testing.ts';
import type { Db } from './client.ts';
import { account, mediaAsset, session, tenant, user } from './schema.ts';

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

  it('identifies OAuth accounts by (issuer, account_id), the way Better Auth 1.7 looks them up', async () => {
    const u = await createUser(db, 'oauth@example.com');
    const row = {
      id: randomUUID(),
      issuer: 'https://accounts.google.com',
      accountId: 'google-sub-1',
      providerId: 'google',
      userId: u.id,
      updatedAt: new Date(),
    };
    await db.insert(account).values(row);
    // the same subject at the same issuer cannot be linked twice
    const dup = await db
      .insert(account)
      .values({ ...row, id: randomUUID() })
      .then(
        () => null,
        (e: unknown) => e as Error & { cause?: { constraint?: string } },
      );
    expect(dup?.cause?.constraint).toBe('account_issuer_account_id_uidx');
    // the lookup Better Auth performs on every social sign-in
    const [found] = await db
      .select({ userId: account.userId })
      .from(account)
      .where(eq(account.issuer, 'https://accounts.google.com'));
    expect(found?.userId).toBe(u.id);
    await db.delete(user).where(eq(user.id, u.id));
    expect(await db.select().from(account).where(eq(account.id, row.id))).toEqual([]);
  });

  it('round-trips bytea through a Buffer and cascades media assets from tenant', async () => {
    const u = await createUser(db, 'bytes@example.com');
    const t = await createTenant(db, 'Bytes', u.id);
    const data = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x10, 0x80]);
    await db.insert(mediaAsset).values({
      id: randomUUID(),
      tenantId: t.id,
      name: 'blip.wav',
      mimeType: 'audio/wav',
      sizeBytes: data.length,
      data,
    });
    const [row] = await db.select().from(mediaAsset).where(eq(mediaAsset.tenantId, t.id));
    expect(Buffer.isBuffer(row!.data)).toBe(true);
    expect(Buffer.compare(row!.data, data)).toBe(0);
    await db.delete(tenant).where(eq(tenant.id, t.id));
    expect(await db.select().from(mediaAsset).where(eq(mediaAsset.tenantId, t.id))).toEqual([]);
  });
});
