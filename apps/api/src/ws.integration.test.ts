import type { ServerMessage } from '@cc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { Db } from './db/client.ts';
import { buildServer } from './server.ts';
import { bootstrapUser, createInvite, createTenant } from './services/tenants.ts';
import {
  INTERNAL_SECRET,
  createUser,
  dbAvailable,
  fakeLiveKit,
  freshDb,
  resetDb,
  testServer,
} from './testing.ts';

const hasDb = await dbAvailable();

type User = { id: string; email: string; name: string };

/** Opens a desk socket for `user` and records every server message. */
async function desk(port: number, user: User, current: { user: User | null }, query = '') {
  current.user = user;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws${query}`);
  const messages: ServerMessage[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    messages,
    send: (m: object | string) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    last: (type: ServerMessage['type']) => [...messages].reverse().find((m) => m.type === type),
    close: () =>
      new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close();
      }),
  };
}

describe.skipIf(!hasDb)('desk websocket: sessions, tenants and malformed input', () => {
  let db: Db;
  let close: () => Promise<void>;
  let srv: Awaited<ReturnType<typeof testServer>>;
  let port: number;
  let boss: User;
  let tenantId: string;
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
    boss = await createUser(db, 'boss@example.com', 'Boss');
    tenantId = (await createTenant(db, 'Acme', boss.id)).id;
  });

  it('keeps presence while the user has another tab open', async () => {
    const a = await desk(port, boss, current, `?tenantId=${tenantId}`);
    const b = await desk(port, boss, current);
    await vi.waitFor(() => expect(b.last('presence')).toBeDefined());
    current.user = boss;
    await srv.app.inject({ method: 'POST', url: '/api/desk/state', payload: { state: 'ready' } });
    await vi.waitFor(() =>
      expect(b.last('presence')).toMatchObject({
        agents: [{ userId: boss.id, state: 'ready' }],
      }),
    );
    await a.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(await srv.flow.routing.snapshot(tenantId)).toMatchObject([{ userId: boss.id }]);
    await b.close();
    await vi.waitFor(async () => expect(await srv.flow.routing.snapshot(tenantId)).toEqual([]));
  });

  it('delivers instant messages, broadcasts, and the ticker (also on connect)', async () => {
    await createInvite(db, tenantId, 'agent@example.com', 'agent');
    const agent = await createUser(db, 'agent@example.com', 'Sam');
    await bootstrapUser(db, agent, []);
    const bossDesk = await desk(port, boss, current);
    const agentDesk = await desk(port, agent, current);
    await vi.waitFor(() => expect(agentDesk.last('presence')).toBeDefined());

    // direct message: only the addressee receives it
    current.user = boss;
    const im = await srv.app.inject({
      method: 'POST',
      url: '/api/desk/messages',
      payload: { text: 'Take five after this call', toUserId: agent.id },
    });
    expect(im.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(agentDesk.last('im')).toMatchObject({
        from: { userId: boss.id, name: 'Boss' },
        text: 'Take five after this call',
        broadcast: false,
      }),
    );
    expect(bossDesk.last('im')).toBeUndefined();

    // broadcast: everyone gets it; agents may not broadcast
    const bc = await srv.app.inject({
      method: 'POST',
      url: '/api/desk/messages',
      payload: { text: 'Stand-up in 5' },
    });
    expect(bc.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(bossDesk.last('im')).toMatchObject({ text: 'Stand-up in 5', broadcast: true });
      expect(agentDesk.last('im')).toMatchObject({ text: 'Stand-up in 5', broadcast: true });
    });
    current.user = agent;
    expect(
      (
        await srv.app.inject({
          method: 'POST',
          url: '/api/desk/messages',
          payload: { text: 'nope' },
        })
      ).statusCode,
    ).toBe(403);

    // ticker: pushed live, persisted, and handed to a fresh connection
    current.user = boss;
    expect(
      (
        await srv.app.inject({
          method: 'PUT',
          url: '/api/desk/ticker',
          payload: { text: 'Systems degraded' },
        })
      ).statusCode,
    ).toBe(200);
    await vi.waitFor(() =>
      expect(agentDesk.last('ticker')).toMatchObject({ text: 'Systems degraded' }),
    );
    const late = await desk(port, agent, current);
    await vi.waitFor(() => expect(late.last('ticker')).toMatchObject({ text: 'Systems degraded' }));
    await Promise.all([bossDesk.close(), agentDesk.close(), late.close()]);
  });

  it('ignores malformed and unknown messages, including ones sent before auth finished', async () => {
    const d = await desk(port, boss, current);
    // sent right after `open`, before the server resolved the session
    d.send('{not json');
    d.send({ type: 'nonsense' });
    d.send({ type: 'subscribe', callId: 'c-early' });
    await vi.waitFor(() =>
      expect(d.last('presence')).toMatchObject({ agents: [{ state: 'not_ready', reason: null }] }),
    );
    d.send('also not json');
    current.user = boss;
    await srv.app.inject({
      method: 'POST',
      url: '/api/desk/state',
      payload: { state: 'not_ready', reason: 'Lunch' },
    });
    await vi.waitFor(() =>
      expect(d.last('presence')).toMatchObject({
        agents: [{ state: 'not_ready', reason: 'Lunch' }],
      }),
    );
    await d.close();
  });

  it('lets a supervisor read presence, force states and log an agent out', async () => {
    await createInvite(db, tenantId, 'agent@example.com', 'agent');
    const agent = await createUser(db, 'agent@example.com', 'Sam');
    await bootstrapUser(db, agent, []);
    const d = await desk(port, agent, current);
    await vi.waitFor(() => expect(d.last('presence')).toBeDefined());
    const as = (u: User) => {
      current.user = u;
      return srv.app;
    };
    const force = (userId: string, payload: object) =>
      as(boss).inject({ method: 'POST', url: `/api/desk/agents/${userId}/state`, payload });

    expect((await as(boss).inject({ url: '/api/desk/agents' })).json()).toMatchObject([
      { userId: agent.id, state: 'not_ready' },
    ]);
    // agents may not force anyone; unknown / offline targets are 404; bad bodies 400
    expect(
      (
        await as(agent).inject({
          method: 'POST',
          url: `/api/desk/agents/${boss.id}/state`,
          payload: { state: 'ready' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await force('nobody', { state: 'ready' })).statusCode).toBe(404);
    expect((await force(agent.id, { state: 'busy' })).statusCode).toBe(400);
    expect(
      (await force(agent.id, { state: 'not_ready', reason: 'Training' })).json(),
    ).toMatchObject({
      state: 'not_ready',
      reason: 'Training',
    });
    await vi.waitFor(() =>
      expect(d.last('presence')).toMatchObject({ agents: [{ reason: 'Training' }] }),
    );
    // on a call: no state change, not even forced
    await srv.flow.routing.busy('c1', agent.id);
    expect((await force(agent.id, { state: 'ready' })).json()).toEqual({ error: 'on_call' });
    expect(
      (
        await as(agent).inject({
          method: 'POST',
          url: '/api/desk/state',
          payload: { state: 'ready' },
        })
      ).json(),
    ).toEqual({ error: 'on_call' });
    await srv.flow.routing.release('c1');
    // offline users cannot set a state
    expect(
      (
        await as(boss).inject({
          method: 'POST',
          url: '/api/desk/state',
          payload: { state: 'ready' },
        })
      ).json(),
    ).toEqual({ error: 'offline' });
    expect(
      (await as(boss).inject({ method: 'POST', url: '/api/desk/acw/extend' })).statusCode,
    ).toBe(409);

    expect((await force(agent.id, { state: 'logged_out' })).json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(d.last('logout')).toMatchObject({ by: 'Boss' }));
    await vi.waitFor(async () => expect(await srv.flow.routing.snapshot(tenantId)).toEqual([]));
  });

  it('rejects a tenant the user is not a member of', async () => {
    current.user = boss;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?tenantId=other`);
    expect(await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)))).toBe(4401);
  });
});

describe.skipIf(!hasDb)('desk websocket: `?as=` picks the dev user', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildServer>>['app'];
  let port: number;

  beforeAll(async () => {
    ({ db, close } = await freshDb());
    ({ app } = await buildServer({
      db,
      livekit: fakeLiveKit().livekit,
      devUserEmail: 'dev@example.com',
      adminEmails: ['dev@example.com'],
      internalSecret: INTERNAL_SECRET,
    }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await app.close();
    await close();
  });

  it('connects two sockets as two different people, and without `as` as the default', async () => {
    const current = { user: null as User | null };
    const dev = (await app.inject({ url: '/api/me' })).json() as { user: User };
    for (const email of ['alice@example.com', 'bob@example.com']) {
      await app.inject({
        method: 'POST',
        url: '/api/admin/invites',
        payload: { email, role: 'agent' },
      });
    }
    const alice = await desk(port, dev.user, current, '?as=alice%40example.com');
    const bob = await desk(port, dev.user, current, '?as=Bob%40Example.com');
    const boss = await desk(port, dev.user, current);
    await vi.waitFor(() => expect(boss.last('presence')).toBeDefined());
    const ids = new Map(
      (
        (await app.inject({ url: '/api/admin/members' })).json() as {
          userId: string;
          email: string;
        }[]
      ).map((m) => [m.email, m.userId]),
    );
    await vi.waitFor(() =>
      expect(
        (boss.last('presence') as { agents: { userId: string }[] }).agents
          .map((a) => a.userId)
          .sort(),
      ).toEqual([ids.get('alice@example.com'), ids.get('bob@example.com'), dev.user.id].sort()),
    );
    expect(ids.get('alice@example.com')).not.toBe(ids.get('bob@example.com'));
    await Promise.all([alice.close(), bob.close(), boss.close()]);
  });
});
