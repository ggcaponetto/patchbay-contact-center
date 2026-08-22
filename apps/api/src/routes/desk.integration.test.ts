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

  it('holds and retrieves the customer, telling the media worker over the bus', async () => {
    const { callId } = await startCall();
    const media: unknown[] = [];
    srv.bus.subscribe((m) => m.kind === 'media' && media.push(m.command));
    const post = (path: string) =>
      srv.as(boss).inject({ method: 'POST', url: `/api/desk/calls/${callId}${path}` });

    expect((await post('/retrieve')).json()).toEqual({ error: 'not_held' });
    expect((await post('/hold')).json()).toEqual({ ok: true });
    expect((await post('/hold')).json()).toEqual({ error: 'already_held' });
    const held = (await srv.as(boss).inject({ url: `/api/desk/calls/${callId}` })).json();
    expect(held.heldAt).not.toBeNull();
    expect((await post('/retrieve')).json()).toEqual({ ok: true });
    const back = (await srv.as(boss).inject({ url: `/api/desk/calls/${callId}` })).json();
    expect(back.heldAt).toBeNull();
    expect(back.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['hold', 'retrieve']),
    );
    await new Promise((r) => setTimeout(r, 0)); // LocalBus delivers on a microtask
    expect(media).toEqual([
      expect.objectContaining({
        action: 'moh.start',
        callId,
        token: `token-for-media:${callId}`,
        url: 'wss://fake.livekit.cloud',
      }),
      { action: 'moh.stop', callId },
    ]);
    // ended calls cannot be held
    const { setCallStatus } = await import('../services/calls.ts');
    await setCallStatus(db, callId, 'ended');
    expect((await post('/hold')).json()).toEqual({ error: 'not_live' });
  });

  it('blind-transfers with hold music until the target accepts', async () => {
    const { createInvite, bootstrapUser, updateSettings } = await import('../services/tenants.ts');
    const me = await srv.as(boss).inject({ url: '/api/me' });
    const tenantId = me.json().memberships[0].tenantId as string;
    await updateSettings(db, tenantId, { acwSec: 0 });
    await createInvite(db, tenantId, 'bob@example.com', 'agent');
    const bob = await createUser(db, 'bob@example.com', 'Bob');
    await bootstrapUser(db, bob, []);
    for (const u of [boss, bob]) {
      await srv.flow.routing.connect({ userId: u.id, tenantId, name: u.name });
      await srv.flow.routing.setState(u.id, 'ready');
    }
    const media: unknown[] = [];
    srv.bus.subscribe((m) => m.kind === 'media' && media.push(m.command));
    const { callId } = await startCall();
    await srv.flow.routing.busy(callId, boss.id);

    // transfer to Bob directly
    const res = await srv.as(boss).inject({
      method: 'POST',
      url: `/api/desk/calls/${callId}/transfer`,
      payload: { target: { kind: 'user', id: bob.id } },
    });
    expect(res.json()).toEqual({ ok: true });
    // the transferring agent is free again, the customer held, Bob rung
    expect((await srv.flow.routing.presenceOf(boss.id))?.state).toBe('ready');
    await new Promise((r) => setTimeout(r, 50));
    expect(await srv.flow.routing.ringing(callId)).toBe(bob.id);
    let detail = (await srv.as(boss).inject({ url: `/api/desk/calls/${callId}` })).json();
    expect(detail).toMatchObject({ status: 'waiting_human' });
    expect(detail.heldAt).not.toBeNull();

    // Bob accepts: joined as human, customer retrieved (retrieveOnAccept)
    const accept = await srv
      .as(bob)
      .inject({ method: 'POST', url: `/api/desk/calls/${callId}/accept` });
    expect(accept.statusCode).toBe(200);
    detail = (await srv.as(bob).inject({ url: `/api/desk/calls/${callId}` })).json();
    expect(detail).toMatchObject({ status: 'human', heldAt: null });
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['transfer', 'hold', 'offer.accepted', 'retrieve']),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(media.map((c) => (c as { action: string }).action)).toEqual(['moh.start', 'moh.stop']);
    // empty target / dead call answers
    expect(
      (
        await srv.as(bob).inject({
          method: 'POST',
          url: `/api/desk/calls/${callId}/transfer`,
          payload: { target: { kind: 'queue', id: 'nope' } },
        })
      ).json(),
    ).toEqual({ error: 'empty_target' });
    await srv.flow.routing.disconnect(boss.id);
    await srv.flow.routing.disconnect(bob.id);
  });

  it('consults a colleague, completes as transfer or conference, and drops', async () => {
    const { createInvite, bootstrapUser, updateSettings } = await import('../services/tenants.ts');
    const me = await srv.as(boss).inject({ url: '/api/me' });
    const tenantId = me.json().memberships[0].tenantId as string;
    await updateSettings(db, tenantId, { acwSec: 0 });
    await createInvite(db, tenantId, 'carol@example.com', 'agent');
    const carol = await createUser(db, 'carol@example.com', 'Carol');
    await bootstrapUser(db, carol, []);
    for (const u of [boss, carol]) {
      await srv.flow.routing.connect({ userId: u.id, tenantId, name: u.name });
      await srv.flow.routing.setState(u.id, 'ready');
    }
    const { callId } = await startCall();
    // boss takes the call
    await srv.flow.routing.busy(callId, boss.id);
    await srv.flow.join(callId, boss, 'agent');

    const post = (u: typeof boss, path: string, payload?: object) =>
      srv.as(u).inject({ method: 'POST', url: `/api/desk/calls/${callId}${path}`, payload });

    // consult Carol: customer held, Carol rung with the consultation reason
    expect((await post(boss, '/consult', { targetUserId: carol.id })).json()).toEqual({
      ok: true,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(await srv.flow.routing.ringing(callId)).toBe(carol.id);
    expect((await post(carol, '/accept')).statusCode).toBe(200);
    let detail = (await srv.as(boss).inject({ url: `/api/desk/calls/${callId}` })).json();
    // customer still held during the consultation, two humans on the call
    expect(detail.heldAt).not.toBeNull();
    const humans = detail.participants.filter(
      (x: { kind: string; leftAt: string | null }) => x.kind === 'human' && x.leftAt === null,
    );
    expect(humans).toHaveLength(2);

    // drop Carol: removed from the room, freed, boss keeps the (held) customer
    expect((await post(boss, '/consult/complete', { mode: 'drop' })).json()).toEqual({
      ok: true,
    });
    expect(srv.lk.removed).toEqual([expect.stringContaining(`human:${carol.id}`)]);
    expect((await srv.flow.routing.presenceOf(carol.id))?.state).toBe('ready');
    expect((await post(boss, '/consult/complete', { mode: 'drop' })).json()).toEqual({
      error: 'no_consultant',
    });
    await post(boss, '/retrieve');

    // consult again and complete as transfer: boss leaves, Carol keeps the customer
    await srv.flow.routing.setState(carol.id, 'ready');
    await post(boss, '/consult', { targetUserId: carol.id });
    await new Promise((r) => setTimeout(r, 50));
    await post(carol, '/accept');
    expect((await post(boss, '/consult/complete', { mode: 'transfer' })).json()).toEqual({
      ok: true,
    });
    detail = (await srv.as(carol).inject({ url: `/api/desk/calls/${callId}` })).json();
    expect(detail.heldAt).toBeNull();
    expect((await srv.flow.routing.presenceOf(boss.id))?.state).toBe('ready');
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['consult', 'consult.dropped', 'transfer.completed']),
    );

    // Carol is now the last human: her leave ends the call
    expect((await post(carol, '/leave', { role: 'human' })).json()).toEqual({ ok: true });
    detail = (await srv.as(carol).inject({ url: `/api/desk/calls/${callId}` })).json();
    expect(detail.status).toBe('ended');
    await srv.flow.routing.disconnect(boss.id);
    await srv.flow.routing.disconnect(carol.id);
  });

  it('rejects malformed bodies and dead calls on the call-control routes', async () => {
    const { callId } = await startCall();
    const post = (path: string, payload?: object) =>
      srv.as(boss).inject({ method: 'POST', url: `/api/desk/calls/${callId}${path}`, payload });
    expect((await post('/transfer', { target: { kind: 'nope' } })).statusCode).toBe(400);
    expect((await post('/consult', {})).statusCode).toBe(400);
    expect((await post('/consult/complete', { mode: 'later' })).statusCode).toBe(400);
    expect((await post('/tags', { tags: 'x' })).statusCode).toBe(400);
    expect((await post('/disposition', {})).statusCode).toBe(400);
    const { setCallStatus } = await import('../services/calls.ts');
    await setCallStatus(db, callId, 'ended');
    expect((await post('/transfer', { target: { kind: 'user', id: boss.id } })).json()).toEqual({
      error: 'not_live',
    });
    expect((await post('/consult', { targetUserId: boss.id })).json()).toEqual({
      error: 'not_live',
    });
    expect((await post('/consult/complete', { mode: 'drop' })).json()).toEqual({
      error: 'not_live',
    });
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
