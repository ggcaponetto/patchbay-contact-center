import type { ServerMessage } from '@cc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { Db } from './db/client.ts';
import {
  bootstrapUser,
  createEmbedKey,
  createInvite,
  createTenant,
  listQueues,
  setQueueMembers,
  updateSettings,
} from './services/tenants.ts';
import {
  INTERNAL_SECRET,
  createUser,
  dbAvailable,
  freshDb,
  resetDb,
  testServer,
} from './testing.ts';

const hasDb = await dbAvailable();

type User = { id: string; email: string; name: string };

/** Desk websocket client that records every server message. */
async function desk(port: number, user: User, current: { user: User | null }) {
  current.user = user;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
  const messages: ServerMessage[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    ws,
    messages,
    send: (m: object) => ws.send(JSON.stringify(m)),
    last: (type: ServerMessage['type']) => [...messages].reverse().find((m) => m.type === type),
    close: () =>
      new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close();
      }),
  };
}

describe.skipIf(!hasDb)('call flow: escalation, ringing, handoff', () => {
  let db: Db;
  let close: () => Promise<void>;
  let srv: Awaited<ReturnType<typeof testServer>>;
  let port: number;
  let boss: Awaited<ReturnType<typeof createUser>>;
  let agent: Awaited<ReturnType<typeof createUser>>;
  let tenantId: string;
  let publicKey: string;
  const internal = { 'x-internal-secret': INTERNAL_SECRET };
  // the session resolver reads this so websocket upgrades can pick their user
  const current: { user: User | null } = { user: null };

  beforeAll(async () => {
    ({ db, close } = await freshDb());
    srv = await testServer(db, [], () => current.user);
    await srv.app.listen({ port: 0, host: '127.0.0.1' });
    port = (srv.app.server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await srv.app.close();
    await close();
  });
  beforeEach(async () => {
    await resetDb(db);
    srv.lk.tokens.length = 0;
    srv.lk.deleted.length = 0;
    srv.lk.dispatched.length = 0;
    boss = await createUser(db, 'boss@example.com', 'Boss');
    tenantId = (await createTenant(db, 'Acme', boss.id)).id;
    await createInvite(db, tenantId, 'agent@example.com', 'agent');
    agent = await createUser(db, 'agent@example.com', 'Sam');
    await bootstrapUser(db, agent, []);
    const [support] = await listQueues(db, tenantId);
    await setQueueMembers(db, tenantId, support!.id, [agent.id, boss.id]);
    publicKey = (await createEmbedKey(db, tenantId, 'site', [])).publicKey;
  });

  const startCall = async () =>
    (
      await srv.app.inject({
        method: 'POST',
        url: '/api/public/calls',
        payload: { embedKey: publicKey, queue: 'support' },
      })
    ).json() as { callId: string; roomName: string };

  const asUser = (u: { id: string; email: string; name: string }) => {
    current.user = u;
    return srv.app;
  };
  /** `POST /api/desk/state` as `u` (states are REST, not socket messages). */
  const setState = (u: User, state: 'ready' | 'not_ready', reason?: string) =>
    asUser(u).inject({ method: 'POST', url: '/api/desk/state', payload: { state, reason } });

  it('rings an available agent on escalation and hands the call over', async () => {
    const { callId } = await startCall();
    const d = await desk(port, agent, current);
    await vi.waitFor(() => expect(d.last('presence')).toBeDefined()); // presence row exists
    expect((await setState(agent, 'ready')).json()).toMatchObject({ state: 'ready' });
    await vi.waitFor(() =>
      expect(d.last('presence')).toMatchObject({
        agents: [{ userId: agent.id, state: 'ready', reason: null }],
      }),
    );

    // the AI asks for a human: long-poll until someone accepts
    const escalation = srv.app.inject({
      method: 'POST',
      url: `/api/internal/calls/${callId}/escalate`,
      headers: internal,
      payload: { reason: 'refund', summary: 'Wants a refund for order 1234.' },
    });
    await vi.waitFor(() =>
      expect(d.last('call.offer')).toMatchObject({ callId, reason: 'refund' }),
    );
    expect(d.last('call.updated')).toMatchObject({ callId, status: 'waiting_human' });

    // someone else cannot accept; the ringing agent can
    expect(
      (await asUser(boss).inject({ method: 'POST', url: `/api/desk/calls/${callId}/accept` }))
        .statusCode,
    ).toBe(409);
    const accepted = await asUser(agent).inject({
      method: 'POST',
      url: `/api/desk/calls/${callId}/accept`,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      token: `token-for-human:${agent.id}`,
      url: 'wss://fake.livekit.cloud',
    });
    expect(srv.lk.tokens.at(-1)).toMatchObject({
      attributes: { role: 'human', userId: agent.id, displayName: 'Sam' },
      canPublish: true,
    });
    expect((await escalation).json()).toEqual({ outcome: 'accepted', agentName: 'Sam' });
    await vi.waitFor(() =>
      expect(d.last('presence')).toMatchObject({ agents: [{ state: 'busy', callId }] }),
    );
    await vi.waitFor(() =>
      expect(d.last('call.updated')).toMatchObject({ callId, status: 'human' }),
    );

    // live transcript reaches subscribers only
    d.send({ type: 'subscribe', callId });
    await new Promise((r) => setTimeout(r, 50));
    await srv.app.inject({
      method: 'POST',
      url: `/api/internal/calls/${callId}/transcript`,
      headers: internal,
      payload: { speaker: 'customer', identity: 'customer:x', text: 'hello again' },
    });
    await vi.waitFor(() =>
      expect(d.last('transcript')).toMatchObject({ callId, segment: { text: 'hello again' } }),
    );

    // the human hangs up: call ends, room deleted, agent freed
    expect(
      (
        await asUser(agent).inject({
          method: 'POST',
          url: `/api/desk/calls/${callId}/leave`,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    await vi.waitFor(() =>
      expect(d.last('call.updated')).toMatchObject({ callId, status: 'ended' }),
    );
    expect(srv.lk.deleted).toHaveLength(1);
    await vi.waitFor(() =>
      expect(d.last('presence')).toMatchObject({ agents: [{ state: 'acw', callId }] }),
    );
    // wrap-up: extend, then finish by hand
    expect(
      (await asUser(agent).inject({ method: 'POST', url: '/api/desk/acw/extend' })).json(),
    ).toMatchObject({ state: 'acw' });
    expect(
      (await asUser(agent).inject({ method: 'POST', url: '/api/desk/acw/done' })).json(),
    ).toMatchObject({ state: 'ready', callId: null });
    expect(
      (await asUser(agent).inject({ method: 'POST', url: '/api/desk/acw/done' })).statusCode,
    ).toBe(409);
    await vi.waitFor(() =>
      expect(d.last('presence')).toMatchObject({ agents: [{ state: 'ready', callId: null }] }),
    );
    const detail = (await asUser(boss).inject({ url: `/api/desk/calls/${callId}` })).json();
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining([
        'escalation.requested',
        'offer.accepted',
        'agent.joined',
        'human.left',
      ]),
    );
    expect(detail.participants.find((p: { kind: string }) => p.kind === 'human')).toMatchObject({
      userId: agent.id,
    });

    await d.close();
    await vi.waitFor(async () => expect(await srv.flow.routing.snapshot(tenantId)).toEqual([]));
  });

  it('reports nobody when the agent declines and nobody else is free', async () => {
    const { callId } = await startCall();
    const d = await desk(port, agent, current);
    await vi.waitFor(() => expect(d.last('presence')).toBeDefined()); // presence row exists
    await setState(agent, 'ready');
    const escalation = srv.app.inject({
      method: 'POST',
      url: `/api/internal/calls/${callId}/escalate`,
      headers: internal,
      payload: { reason: 'r', summary: 's' },
    });
    await vi.waitFor(() => expect(d.last('call.offer')).toBeDefined());
    d.send({ type: 'offer.decline', callId });
    expect((await escalation).json()).toEqual({ outcome: 'nobody' });
    await vi.waitFor(() => expect(d.last('call.offer.cancelled')).toMatchObject({ callId }));
    await vi.waitFor(() => expect(d.last('call.updated')).toMatchObject({ callId, status: 'ai' }));
    d.send('not json at all');
    d.send(JSON.stringify({ type: 'bogus' }));
    await d.close();
  });

  it('rings humans first and falls back to the AI on timeout', async () => {
    await updateSettings(db, tenantId, {
      routingMode: 'human-first',
      humanFirstTimeoutSec: 5,
      offerTimeoutSec: 5,
    });
    const d = await desk(port, agent, current);
    await vi.waitFor(() => expect(d.last('presence')).toBeDefined()); // presence row exists
    await setState(agent, 'ready');
    const { callId, roomName } = await startCall();
    await vi.waitFor(() => expect(d.last('call.offer')).toMatchObject({ callId }));
    expect(srv.lk.dispatched).toEqual([]);
    // Ring timeouts are detected by the engine's periodic tick when `ring_until` /
    // `give_up_at` pass; age the offer into the past and run one tick by hand.
    const { ringOffer } = await import('./db/schema.ts');
    const past = new Date(Date.now() - 1000);
    await db.update(ringOffer).set({ ringUntil: past, giveUpAt: past });
    await srv.flow.routing.tick();
    await vi.waitFor(() => expect(srv.lk.dispatched).toEqual([roomName]));
    await vi.waitFor(() => expect(d.last('call.updated')).toMatchObject({ callId, status: 'ai' }));
    await d.close();
  });

  it('whispers to the agent only, barges audibly, and intercepts the agent', async () => {
    const { callId } = await startCall();
    // whisper: publishing supervisor whose tracks the embed will not play
    const whisper = await asUser(boss).inject({
      method: 'POST',
      url: `/api/desk/calls/${callId}/join`,
      payload: { mode: 'whisper' },
    });
    expect(whisper.statusCode).toBe(200);
    expect(srv.lk.tokens.at(-1)).toMatchObject({
      attributes: { role: 'supervisor', monitor: 'whisper' },
      canPublish: true,
    });
    let detail = (await asUser(boss).inject({ url: `/api/desk/calls/${callId}` })).json();
    expect(detail.status).toBe('ai'); // monitoring never changes the status
    expect(detail.events.map((e: { type: string }) => e.type)).toContain('whisper.joined');
    await asUser(boss).inject({
      method: 'POST',
      url: `/api/desk/calls/${callId}/leave`,
      payload: { role: 'supervisor' },
    });

    // barge: audible to everyone — no whisper flag on the token
    const barge = await asUser(boss).inject({
      method: 'POST',
      url: `/api/desk/calls/${callId}/join`,
      payload: { mode: 'barge' },
    });
    expect(barge.statusCode).toBe(200);
    const bargeToken = srv.lk.tokens.at(-1) as { attributes: Record<string, string> };
    expect(bargeToken.attributes['monitor']).toBeUndefined();
    expect(bargeToken.attributes['role']).toBe('supervisor');
    await asUser(boss).inject({
      method: 'POST',
      url: `/api/desk/calls/${callId}/leave`,
      payload: { role: 'supervisor' },
    });

    // hand the call to the agent, then intercept it as the supervisor
    await srv.flow.routing.connect({ userId: agent.id, tenantId, name: agent.name });
    await setState(agent, 'ready');
    const escalated = srv.app.inject({
      method: 'POST',
      url: `/api/internal/calls/${callId}/escalate`,
      headers: internal,
      payload: { reason: 'vip', summary: 'Needs a manager.' },
    });
    await vi.waitFor(async () => {
      const r = await asUser(agent).inject({
        method: 'POST',
        url: `/api/desk/calls/${callId}/accept`,
      });
      expect(r.statusCode).toBe(200);
    });
    await escalated;
    const intercept = await asUser(boss).inject({
      method: 'POST',
      url: `/api/desk/calls/${callId}/join`,
      payload: { mode: 'intercept' },
    });
    expect(intercept.statusCode).toBe(200);
    detail = (await asUser(boss).inject({ url: `/api/desk/calls/${callId}` })).json();
    expect(detail.status).toBe('human');
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['intercept', 'intercept.joined']),
    );
    // the agent was kicked from the room, marked gone and freed
    expect(srv.lk.removed).toContainEqual(expect.stringContaining(`:human:${agent.id}`));
    const humans = detail.participants.filter(
      (p: { kind: string; leftAt: string | null }) => p.kind === 'human' && p.leftAt === null,
    );
    expect(humans).toHaveLength(1);
    expect(humans[0].userId).toBe(boss.id);
    const presence = await srv.flow.routing.presenceOf(agent.id);
    expect(presence?.state).not.toBe('busy');
  });

  it('lets supervisors listen in or take over, and rejects bad requests', async () => {
    const { callId } = await startCall();
    const listen = await asUser(boss).inject({
      method: 'POST',
      url: `/api/desk/calls/${callId}/join`,
      payload: { mode: 'listen' },
    });
    expect(listen.statusCode).toBe(200);
    expect(srv.lk.tokens.at(-1)).toMatchObject({
      attributes: { role: 'supervisor' },
      canPublish: false,
    });
    expect(
      (
        await asUser(boss).inject({
          method: 'POST',
          url: `/api/desk/calls/${callId}/leave`,
          payload: { role: 'supervisor' },
        })
      ).statusCode,
    ).toBe(200);
    expect((await asUser(boss).inject({ url: `/api/desk/calls/${callId}` })).json().status).toBe(
      'ai',
    );

    const takeover = await asUser(boss).inject({
      method: 'POST',
      url: `/api/desk/calls/${callId}/join`,
      payload: { mode: 'takeover' },
    });
    expect(takeover.statusCode).toBe(200);
    expect((await asUser(boss).inject({ url: `/api/desk/calls/${callId}` })).json().status).toBe(
      'human',
    );

    expect(
      (
        await asUser(agent).inject({
          method: 'POST',
          url: `/api/desk/calls/${callId}/join`,
          payload: { mode: 'listen' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await asUser(boss).inject({
          method: 'POST',
          url: `/api/desk/calls/${callId}/join`,
          payload: { mode: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await asUser(boss).inject({
          method: 'POST',
          url: `/api/desk/calls/nope/join`,
          payload: { mode: 'listen' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await asUser(boss).inject({ method: 'POST', url: `/api/desk/calls/nope/accept` }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await asUser(boss).inject({
          method: 'POST',
          url: `/api/desk/calls/nope/leave`,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await asUser(boss).inject({
          method: 'POST',
          url: `/api/desk/calls/${callId}/leave`,
          payload: { role: 'nope' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await asUser(boss).inject({ method: 'POST', url: `/api/desk/calls/${callId}/decline` }))
        .statusCode,
    ).toBe(200);

    // ending twice is harmless; joining an ended call is refused; escalating it reports nobody
    await srv.flow.end(callId);
    await srv.flow.end(callId);
    expect(
      (
        await asUser(boss).inject({
          method: 'POST',
          url: `/api/desk/calls/${callId}/join`,
          payload: { mode: 'listen' },
        })
      ).statusCode,
    ).toBe(409);
    const late = await srv.app.inject({
      method: 'POST',
      url: `/api/internal/calls/${callId}/escalate`,
      headers: internal,
      payload: { reason: 'r', summary: 's' },
    });
    expect(late.json()).toEqual({ outcome: 'nobody' });
    const bad = await srv.app.inject({
      method: 'POST',
      url: `/api/internal/calls/${callId}/escalate`,
      headers: internal,
      payload: {},
    });
    expect(bad.statusCode).toBe(400);
    expect(
      (
        await srv.app.inject({
          method: 'POST',
          url: `/api/internal/calls/nope/escalate`,
          headers: internal,
          payload: { reason: 'r', summary: 's' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('closes websockets without a session or membership', async () => {
    current.user = null;
    const anon = new WebSocket(`ws://127.0.0.1:${port}/api/ws`);
    const code = await new Promise<number>((resolve) => anon.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);
    const stranger = await createUser(db, 'stranger@example.com');
    current.user = stranger;
    const s = new WebSocket(`ws://127.0.0.1:${port}/api/ws?tenantId=${tenantId}`);
    expect(await new Promise<number>((resolve) => s.on('close', (c) => resolve(c)))).toBe(4401);
  });
});
