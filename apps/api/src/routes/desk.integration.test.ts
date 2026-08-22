import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/client.ts';
import { setCallStatus } from '../services/calls.ts';
import { createEmbedKey, createTenant } from '../services/tenants.ts';
import {
  INTERNAL_SECRET,
  createUser,
  dbAvailable,
  freshDb,
  resetDb,
  testServer,
} from '../testing.ts';

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)('desk routes: authorization and edge cases', () => {
  let db: Db;
  let close: () => Promise<void>;
  let srv: Awaited<ReturnType<typeof testServer>>;
  let boss: Awaited<ReturnType<typeof createUser>>;
  let stranger: Awaited<ReturnType<typeof createUser>>;
  let publicKey: string;
  const internal = { 'x-internal-secret': INTERNAL_SECRET };

  beforeAll(async () => {
    ({ db, close } = await freshDb());
    srv = await testServer(db);
  });
  afterAll(async () => {
    await srv.app.close();
    await close();
  });
  beforeEach(async () => {
    await resetDb(db);
    srv.lk.deleted.length = 0;
    boss = await createUser(db, 'boss@example.com', 'Boss');
    stranger = await createUser(db, 'stranger@example.com');
    const tenantId = (await createTenant(db, 'Acme', boss.id)).id;
    publicKey = (await createEmbedKey(db, tenantId, 'site', [])).publicKey;
  });

  const startCall = async () =>
    (
      await srv.app.inject({
        method: 'POST',
        url: '/api/public/calls',
        payload: { embedKey: publicKey, queue: 'support' },
      })
    ).json() as { callId: string };

  it('answers 401 without a session and 403 without a membership', async () => {
    expect((await srv.as(null).inject({ url: '/api/desk/calls' })).statusCode).toBe(401);
    expect((await srv.as(stranger).inject({ url: '/api/desk/calls' })).statusCode).toBe(403);
    expect((await srv.as(stranger).inject({ url: '/api/desk/calls' })).json()).toEqual({
      error: 'no_tenant',
    });
    // supervisor-only routes fail the same way before the role is even looked at
    const join = {
      method: 'POST' as const,
      url: '/api/desk/calls/x/join',
      payload: { mode: 'listen' },
    };
    expect((await srv.as(null).inject(join)).statusCode).toBe(401);
    expect((await srv.as(stranger).inject(join)).statusCode).toBe(403);
  });

  it('refuses to hand out a token when the call ended while it was ringing', async () => {
    const { callId } = await startCall();
    srv.flow.routing.connect({
      userId: boss.id,
      tenantId: (await srv.as(boss).inject({ url: '/api/me' })).json().memberships[0].tenantId,
      name: 'Boss',
    });
    srv.flow.routing.setState(boss.id, 'ready');
    const escalation = srv.app.inject({
      method: 'POST',
      url: `/api/internal/calls/${callId}/escalate`,
      headers: internal,
      payload: { reason: 'r', summary: 's' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await srv.flow.routing.ringing(callId)).toBe(boss.id);
    // the customer hung up and the worker already wrote `ended`, but the offer is still live
    await setCallStatus(db, callId, 'ended');
    const accept = await srv.as(boss).inject({
      method: 'POST',
      url: `/api/desk/calls/${callId}/accept`,
    });
    expect(accept.statusCode).toBe(409);
    expect(accept.json()).toEqual({ error: 'call_over' });
    expect((await escalation).json()).toMatchObject({ outcome: 'accepted' });
    await srv.flow.routing.disconnect(boss.id);
  });

  it('stores notes, tags and dispositions, and gates wrap-up on the mandatory code', async () => {
    const { updateSettings } = await import('../services/tenants.ts');
    const me = await srv.as(boss).inject({ url: '/api/me' });
    const tenantId = me.json().memberships[0].tenantId as string;
    await updateSettings(db, tenantId, {
      dispositions: [
        { code: 'billing/refund', label: 'Refund' },
        { code: 'resolved', label: 'Resolved' },
      ],
      dispositionRequired: true,
      acwSec: 60,
    });
    const settings = await srv.as(boss).inject({ url: '/api/desk/settings' });
    expect(settings.json()).toMatchObject({
      dispositionRequired: true,
      dispositions: [{ code: 'billing/refund' }, { code: 'resolved' }],
    });
    const { callId } = await startCall();
    const post = (path: string, payload: object) =>
      srv.as(boss).inject({ method: 'POST', url: `/api/desk/calls/${callId}${path}`, payload });

    expect((await post('/note', { text: 'Caller very unhappy' })).json()).toEqual({ ok: true });
    expect((await post('/tags', { tags: ['vip', 'complaint'] })).json()).toEqual({ ok: true });
    expect((await post('/disposition', { code: 'nope' })).json()).toEqual({
      error: 'unknown_code',
    });
    // unknown call ids are 404 on all three
    expect(
      (
        await srv
          .as(boss)
          .inject({ method: 'POST', url: '/api/desk/calls/nope/note', payload: { text: 'x' } })
      ).statusCode,
    ).toBe(404);

    // an agent in wrap-up for this call cannot finish before the disposition is set
    await srv.flow.routing.connect({ userId: boss.id, tenantId, name: 'Boss' });
    await srv.flow.routing.busy(callId, boss.id);
    await srv.flow.routing.release(callId, { acwSec: 60 });
    const done = () => srv.as(boss).inject({ method: 'POST', url: '/api/desk/acw/done' });
    expect((await done()).json()).toEqual({ error: 'disposition_required' });
    expect(
      (await post('/disposition', { code: 'billing/refund', note: 'refund sent' })).json(),
    ).toEqual({ ok: true });
    expect((await done()).json()).toMatchObject({ state: 'ready' });

    const detail = (await srv.as(boss).inject({ url: `/api/desk/calls/${callId}` })).json();
    expect(detail).toMatchObject({ dispositionCode: 'billing/refund', tags: ['vip', 'complaint'] });
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['note', 'disposition']),
    );
    expect(detail.events.find((e: { type: string }) => e.type === 'note').payload).toMatchObject({
      text: 'Caller very unhappy',
      name: 'Boss',
    });
    await srv.flow.routing.disconnect(boss.id);
  });

  it('treats a body-less leave as the human agent leaving', async () => {
    const { callId } = await startCall();
    const res = await srv
      .as(boss)
      .inject({ method: 'POST', url: `/api/desk/calls/${callId}/leave` });
    expect(res.statusCode).toBe(200);
    expect((await srv.as(boss).inject({ url: `/api/desk/calls/${callId}` })).json()).toMatchObject({
      status: 'ended',
    });
    expect(srv.lk.deleted).toHaveLength(1);
  });
});
