import type { ServerMessage } from '@cc/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { Db } from './db/client.ts';
import { bootstrapUser, createInvite, createTenant } from './services/tenants.ts';
import { createUser, dbAvailable, freshDb, resetDb, testServer } from './testing.ts';

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
