import type { AgentPresence } from '@cc/shared';
import { defaultTenantSettings } from '@cc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { createUser, dbAvailable, freshDb, resetDb } from '../testing.ts';
import { addParticipant, createCall, setCallStatus } from './calls.ts';
import { tenantStats } from './stats.ts';
import { createTenant, listQueues } from './tenants.ts';

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)('tenantStats', () => {
  let db: Db;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = await freshDb());
    await resetDb(db);
  });
  afterAll(() => close());

  const presence = (state: AgentPresence['state']): AgentPresence => ({
    userId: `u-${state}`,
    name: state,
    state,
    reason: null,
    since: new Date().toISOString(),
    callId: null,
    acwUntil: null,
  });

  it('counts calls, ages, agents and today totals, and raises threshold alerts', async () => {
    const boss = await createUser(db, 'stats-boss@example.com', 'Boss');
    const tenantId = (await createTenant(db, 'Acme Stats', boss.id)).id;
    const [q] = await listQueues(db, tenantId);
    let n = 0;
    const mk = async () => {
      n += 1;
      const c = await createCall(db, {
        id: `call-stats-${n}`,
        tenantId,
        queueId: q!.id,
        roomName: `room-stats-${n}`,
        customerMeta: {},
      });
      return c.id;
    };

    const waiting = await mk();
    await setCallStatus(db, waiting, 'waiting_human');
    const withAi = await mk();
    await setCallStatus(db, withAi, 'ai');
    const answered = await mk();
    await addParticipant(db, {
      callId: answered,
      kind: 'human',
      identity: `human:${boss.id}`,
      userId: boss.id,
    });
    await setCallStatus(db, answered, 'ended');

    const settings = {
      ...defaultTenantSettings(),
      alerts: { maxWaiting: 1, maxWaitSec: 0, maxCallSec: 3600 },
    };
    const agents = [presence('ready'), presence('busy'), presence('acw'), presence('not_ready')];
    const now = Date.now() + 10_000; // every call is ~10s old
    const s = await tenantStats(db, tenantId, agents, settings, now);
    expect(s.waiting).toBe(1);
    expect(s.active).toBe(2); // waiting + ai; the answered one ended
    expect(s.longestWaitSec).toBeGreaterThanOrEqual(9);
    expect(s.longestCallSec).toBeGreaterThanOrEqual(9);
    expect(s.agents).toEqual({ ready: 1, notReady: 1, busy: 1, acw: 1 });
    expect(s.today.calls).toBe(3);
    expect(s.today.answered).toBe(1);
    expect(s.today.avgHandleSec).toBeGreaterThanOrEqual(0);
    expect(s.alerts).toEqual(['1 calls waiting (limit 1)']); // maxCallSec far away, maxWaitSec off

    // wait-age threshold fires too when configured
    const s2 = await tenantStats(
      db,
      tenantId,
      [],
      { ...settings, alerts: { maxWaiting: 0, maxWaitSec: 5, maxCallSec: 1 } },
      now,
    );
    expect(s2.alerts).toHaveLength(2);
    expect(s2.agents).toEqual({ ready: 0, notReady: 0, busy: 0, acw: 0 });

    // and a quiet tenant has none
    const s3 = await tenantStats(db, tenantId, [], defaultTenantSettings(), now);
    expect(s3.alerts).toEqual([]);
  });
});
