import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusMessage } from './bus.ts';
import { LocalBus } from './bus.ts';
import type { Db } from './db/client.ts';
import { Routing } from './routing.ts';
import { createTenant } from './services/tenants.ts';
import { createUser, dbAvailable, freshDb, resetDb } from './testing.ts';

const hasDb = await dbAvailable();

/** Drains the LocalBus (delivery is a microtask away). */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe.skipIf(!hasDb)('Routing (Postgres)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let tenantId: string;
  let clock = 0;
  const messages: BusMessage[] = [];
  const nobody = vi.fn(async () => undefined);
  const accepted = vi.fn(async () => undefined);
  let r: Routing;
  /** Call ids need a real call row (FK); this inserts one. */
  const callRow = async (id: string) => {
    const { call, queue } = await import('./db/schema.ts');
    const [q] = await db.select().from(queue);
    await db.insert(call).values({
      id,
      tenantId,
      queueId: q!.id,
      roomName: `room-${id}`,
      status: 'ai',
    });
  };
  const users: Record<string, string> = {};
  const agent = async (name: string, state: 'ready' | 'not_ready' = 'ready') => {
    users[name] ??= (await createUser(db, `${name}@example.com`, name)).id;
    await r.connect({ userId: users[name]!, tenantId, name });
    if (state === 'ready') await r.setState(users[name]!, 'ready');
    return users[name]!;
  };
  const offersTo = () =>
    messages
      .filter((m) => m.kind === 'send' && m.message.type === 'call.offer')
      .map((m) => (m as { userId: string }).userId);
  const of = async (userId: string) =>
    (await r.snapshot(tenantId)).find((p) => p.userId === userId);
  const at = async (ms: number) => {
    clock = ms;
    await r.tick();
    await flush();
  };

  beforeAll(async () => {
    ({ db, close } = await freshDb());
  });
  afterAll(() => close());
  beforeEach(async () => {
    await resetDb(db);
    for (const k of Object.keys(users)) delete users[k];
    const boss = await createUser(db, 'boss@example.com', 'Boss');
    tenantId = (await createTenant(db, 'T', boss.id)).id;
    clock = 0;
    messages.length = 0;
    nobody.mockClear();
    accepted.mockClear();
    const bus = new LocalBus();
    bus.subscribe((m) => messages.push(m));
    r = new Routing({
      db,
      bus,
      instanceId: 'test-1',
      events: { onNobody: nobody, onAccepted: accepted },
      offerTimeoutSec: 10,
      now: () => clock,
    });
  });

  /** Gives a user a skill at a proficiency. */
  const skill = async (userId: string, name: string, proficiency: number) => {
    const { userSkill } = await import('./db/schema.ts');
    await db.insert(userSkill).values({ tenantId, userId, skill: name, proficiency });
  };

  it('filters candidates by required skills', async () => {
    const a = await agent('a');
    const b = await agent('b');
    await skill(a, 'billing', 3);
    await callRow('cs1');
    await r.offer({
      callId: 'cs1',
      tenantId,
      queueKey: 'support',
      members: [a, b],
      skills: [{ skill: 'billing', min: 2 }],
    });
    await flush();
    expect(offersTo()).toEqual([a]); // b never qualifies
    await r.decline('cs1', a);
    await flush();
    expect(nobody).toHaveBeenCalledWith('cs1', tenantId, null);
  });

  it('orders by proficiency for the skilled algorithms', async () => {
    const a = await agent('a');
    const b = await agent('b');
    await skill(a, 'billing', 1);
    await skill(b, 'billing', 5);
    await callRow('cs2');
    await r.offer({
      callId: 'cs2',
      tenantId,
      queueKey: 'support',
      members: [a, b],
      algorithm: 'most_skilled',
      skills: [{ skill: 'billing', min: 1 }],
    });
    await flush();
    expect(offersTo()).toEqual([b]); // the expert first
    await r.release('cs2');
    messages.length = 0;
    await callRow('cs3');
    await r.offer({
      callId: 'cs3',
      tenantId,
      queueKey: 'support',
      members: [a, b],
      algorithm: 'least_skilled',
      skills: [{ skill: 'billing', min: 1 }],
    });
    await flush();
    expect(offersTo()).toEqual([a]); // keep the expert free
    await r.release('cs3');
  });

  it('orders by idle time, occupancy and round robin', async () => {
    // b has been ready longer than a (the clock moves between connects)
    const b = await agent('b');
    clock = 5_000;
    const a = await agent('a');
    await callRow('cl1');
    await r.offer({ callId: 'cl1', tenantId, queueKey: 'support', members: [a, b] });
    await flush();
    expect(offersTo()).toEqual([b]); // longest idle (the default)
    await r.accept('cl1', b); // b handled one call
    await r.release('cl1');
    messages.length = 0;

    // least_occupied now prefers a (0 handled vs 1)
    await callRow('cl2');
    await r.offer({
      callId: 'cl2',
      tenantId,
      queueKey: 'support',
      members: [a, b],
      algorithm: 'least_occupied',
    });
    await flush();
    expect(offersTo()).toEqual([a]);
    await r.release('cl2');
    messages.length = 0;

    // round robin prefers b: a was offered a call more recently
    await callRow('cl3');
    await r.offer({
      callId: 'cl3',
      tenantId,
      queueKey: 'support',
      members: [a, b],
      algorithm: 'round_robin',
    });
    await flush();
    expect(offersTo()).toEqual([b]);
    await r.release('cl3');
  });

  it('rings the preferred (sticky) agent first when they are ready', async () => {
    const a = await agent('a');
    clock = 5_000;
    const b = await agent('b'); // b connected later: would lose every ordering
    await callRow('cp1');
    await r.offer({
      callId: 'cp1',
      tenantId,
      queueKey: 'support',
      members: [a, b],
      preferredUserId: b,
    });
    await flush();
    expect(offersTo()).toEqual([b]);
    await r.release('cp1');
  });

  it('rings ready queue members one at a time and hands the call to the acceptor', async () => {
    const a = await agent('a');
    const b = await agent('b');
    await agent('c'); // not in the queue
    await agent('d', 'not_ready');
    await callRow('c1');
    await r.offer({
      callId: 'c1',
      tenantId,
      queueKey: 'support',
      members: [a, b, users.d!],
      reason: 'billing',
      summary: 'x',
    });
    await flush();
    expect(offersTo()).toEqual([a]);
    expect(messages.at(-1)).toMatchObject({ message: { reason: 'billing', summary: 'x' } });
    expect(await r.ringing('c1')).toBe(a);
    // duplicate offers are ignored
    await r.offer({ callId: 'c1', tenantId, queueKey: 'support', members: [a, b] });
    await flush();
    expect(offersTo()).toEqual([a]);

    await r.decline('c1', b); // not b's offer
    await r.decline('c1', a);
    await flush();
    expect(offersTo()).toEqual([a, b]);
    expect(
      messages.some(
        (m) => m.kind === 'send' && m.userId === a && m.message.type === 'call.offer.cancelled',
      ),
    ).toBe(true);

    expect(await r.accept('c1', a)).toBeNull();
    expect(await r.accept('c1', b)).toMatchObject({ callId: 'c1', retrieveOnAccept: false });
    expect(accepted).toHaveBeenCalledWith('c1', b);
    expect(await of(b)).toMatchObject({ state: 'busy', callId: 'c1', reason: null });
    expect(await r.ringing('c1')).toBeNull();
    expect(await r.setState(b, 'not_ready', 'Break')).toBe('on_call');

    await r.release('c1');
    expect(await of(b)).toMatchObject({ state: 'ready', callId: null, acwUntil: null });
    expect(nobody).not.toHaveBeenCalled();
  });

  it('moves on when the tick sees a ring timeout (RONA) and gives up when everyone was tried', async () => {
    const a = await agent('a');
    const b = await agent('b');
    await callRow('c1');
    await r.offer({ callId: 'c1', tenantId, queueKey: 'support', members: [a, b] });
    await at(9_000);
    expect(offersTo()).toEqual([a]);
    await at(10_000);
    expect(offersTo()).toEqual([a, b]);
    expect(await of(a)).toMatchObject({ state: 'not_ready', reason: 'RONA' });
    await at(20_000);
    expect(nobody).toHaveBeenCalledWith('c1', tenantId, null);
    expect(await r.ringing('c1')).toBeNull();
  });

  it('gives up immediately when nobody is online for the queue and passes the fallback', async () => {
    await agent('x');
    await callRow('c1');
    await r.offer({ callId: 'c1', tenantId, queueKey: 'support', members: [], fallback: { k: 1 } });
    expect(nobody).toHaveBeenCalledWith('c1', tenantId, { k: 1 });
  });

  it('respects the overall deadline in human-first mode', async () => {
    const a = await agent('a');
    const b = await agent('b');
    const c = await agent('c');
    await callRow('c1');
    await r.offer({
      callId: 'c1',
      tenantId,
      queueKey: 'support',
      members: [a, b, c],
      giveUpAfterSec: 15,
    });
    await flush();
    expect(messages.at(-1)).toMatchObject({
      message: { expiresAt: new Date(10_000).toISOString() },
    });
    await at(10_000);
    expect(offersTo()).toEqual([a, b]);
    // second ring is shortened to the 5s left on the deadline
    expect(messages.at(-1)).toMatchObject({
      message: { expiresAt: new Date(15_000).toISOString() },
    });
    await at(15_000);
    expect(nobody).toHaveBeenCalledTimes(1);
    expect(offersTo()).toEqual([a, b]);
  });

  it('tracks states, wrap-up timers, disconnects and dead instances', async () => {
    expect(await r.setState('ghost', 'ready')).toBe('offline');
    const a = await agent('a');
    const b = await agent('b');
    clock = 5_000;
    await r.setState(a, 'not_ready', 'Lunch');
    expect(await of(a)).toMatchObject({
      state: 'not_ready',
      reason: 'Lunch',
      since: new Date(5_000).toISOString(),
    });
    // a second tab keeps the state
    await r.connect({ userId: a, tenantId, name: 'a' });
    expect(await of(a)).toMatchObject({ state: 'not_ready', reason: 'Lunch' });

    await r.setState(a, 'ready');
    await callRow('c1');
    await r.offer({ callId: 'c1', tenantId, queueKey: 'support', members: [a] });
    await r.accept('c1', a);
    await r.release('c1', { acwSec: 30 });
    expect(await of(a)).toMatchObject({
      state: 'acw',
      callId: 'c1',
      acwUntil: new Date(35_000).toISOString(),
    });
    expect(await r.extendAcw(a, 30)).toBe(true);
    expect(await of(a)).toMatchObject({ acwUntil: new Date(65_000).toISOString() });
    await at(64_000);
    expect(await of(a)).toMatchObject({ state: 'acw' });
    await at(65_000);
    expect(await of(a)).toMatchObject({ state: 'ready', callId: null, acwUntil: null });
    expect(await r.extendAcw(a, 30)).toBe(false);
    // finishing wrap-up by hand
    await r.busy('c1', a);
    await r.release('c1', { acwSec: 30 });
    expect(await r.setState(a, 'ready')).toBeNull();
    expect(await of(a)).toMatchObject({ state: 'ready', acwUntil: null });
    await r.busy('c1', 'nobody-here');

    // disconnect while ringing moves the offer on; the other agent is busy ringing c2.
    // Longest idle rings b first for c2: a's ready stint restarted just now, b's did not.
    await callRow('c2');
    await callRow('c3');
    await r.offer({ callId: 'c2', tenantId, queueKey: 'support', members: [a, b] });
    await r.offer({ callId: 'c3', tenantId, queueKey: 'support', members: [a, b] });
    await flush();
    expect(offersTo().slice(-2)).toEqual([b, a]);
    await r.disconnect(a);
    await r.disconnect('nobody-here');
    expect(nobody).toHaveBeenCalledWith('c3', tenantId, null);
    expect(await r.presenceOf(a)).toBeUndefined();

    // a dead instance's users are swept by the tick (heartbeat older than 30 s)
    expect(await r.presenceOf(b)).toMatchObject({ instanceId: 'test-1' });
    const other = new Routing({
      db,
      bus: new LocalBus(),
      instanceId: 'test-2',
      events: { onNobody: nobody, onAccepted: accepted },
      now: () => clock,
    });
    await other.connect({ userId: b, tenantId, name: 'b' }); // re-homed on test-2
    clock += 31_000;
    await r.tick(); // test-1 heartbeats only its own users: b (on test-2) is stale
    expect(await r.presenceOf(b)).toBeUndefined();
    expect(nobody).toHaveBeenCalledWith('c3', tenantId, null);
    // a cancelled offer tells the ringing agent
    const z = await agent('z');
    await callRow('c4');
    await r.offer({ callId: 'c4', tenantId, queueKey: 'support', members: [z] });
    await r.release('c4');
    await flush();
    expect(messages).toContainEqual({
      kind: 'send',
      userId: z,
      message: { type: 'call.offer.cancelled', callId: 'c4' },
    });
    expect(await r.snapshot('t-other')).toEqual([]);
    r.start(60_000);
    r.start(60_000);
    r.stop();
  });
});
