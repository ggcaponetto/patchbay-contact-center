import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalBus, PgBus } from './bus.ts';
import { dbAvailable } from './testing.ts';

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)('PgBus', () => {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL ?? '';
  let a: PgBus;
  let b: PgBus;

  beforeAll(async () => {
    a = new PgBus(url);
    b = new PgBus(url);
    await Promise.all([a.start(), b.start()]);
  });
  afterAll(async () => {
    await Promise.all([a.close(), b.close()]);
  });

  it('delivers a published message to every instance, including the publisher', async () => {
    const seenByA: unknown[] = [];
    const seenByB: unknown[] = [];
    a.subscribe((m) => seenByA.push(m));
    b.subscribe((m) => seenByB.push(m));
    const message = { kind: 'presence', tenantId: 't-bus' } as const;
    await a.publish(message);
    await vi.waitFor(() => {
      expect(seenByA).toContainEqual(message);
      expect(seenByB).toContainEqual(message);
    });
  });
});

describe('LocalBus', () => {
  it('delivers on a microtask and stops after close', async () => {
    const bus = new LocalBus();
    const seen: unknown[] = [];
    bus.subscribe((m) => seen.push(m));
    const publishing = bus.publish({ kind: 'presence', tenantId: 't' });
    expect(seen).toEqual([]); // never synchronously (publishers must not re-enter handlers)
    await publishing;
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    await bus.close();
    await bus.publish({ kind: 'presence', tenantId: 't' });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
  });
});
