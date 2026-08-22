import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/client.ts';
import { createEmbedKey, createTenant, updateSettings } from '../src/services/tenants.ts';
import {
  INTERNAL_SECRET,
  createUser,
  dbAvailable,
  freshDb,
  resetDb,
  testServer,
} from './helpers.ts';

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)('calls: public, internal and desk routes', () => {
  let db: Db;
  let close: () => Promise<void>;
  let srv: Awaited<ReturnType<typeof testServer>>;
  let boss: Awaited<ReturnType<typeof createUser>>;
  let tenantId: string;
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
    srv.lk.tokens.length = 0;
    srv.lk.deleted.length = 0;
    boss = await createUser(db, 'boss@example.com');
    tenantId = (await createTenant(db, 'Acme', boss.id)).id;
    publicKey = (await createEmbedKey(db, tenantId, 'site', ['https://shop.example'])).publicKey;
  });

  const startCall = (headers: Record<string, string> = { origin: 'https://shop.example' }) =>
    srv.app.inject({
      method: 'POST',
      url: '/api/public/calls',
      headers,
      payload: { embedKey: publicKey, queue: 'support', customerMeta: { page: '/pricing' } },
    });

  it('creates an AI-first call with a dispatching customer token', async () => {
    const res = await startCall();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toBe('wss://fake.livekit.cloud');
    expect(body.roomName).toBe(`cc-${tenantId}-${body.callId}`);
    expect(srv.lk.tokens[0]).toMatchObject({
      identity: `customer:${body.callId}`,
      attributes: { role: 'customer' },
    });
    const meta = JSON.parse((srv.lk.tokens[0] as { dispatchMetadata: string }).dispatchMetadata);
    expect(meta).toMatchObject({
      callId: body.callId,
      queueKey: 'support',
      customerMeta: { page: '/pricing' },
    });

    const detail = await srv.as(boss).inject({ url: `/api/desk/calls/${body.callId}` });
    expect(detail.json()).toMatchObject({ status: 'ai', participants: [{ kind: 'customer' }] });
    expect(detail.json().events.map((e: { type: string }) => e.type)).toEqual(['call.created']);
  });

  it('does not dispatch the AI in human-first mode', async () => {
    await updateSettings(db, tenantId, { routingMode: 'human-first' });
    const body = (await startCall()).json();
    expect(srv.lk.tokens[0]).not.toHaveProperty('dispatchMetadata');
    const list = (await srv.as(boss).inject({ url: '/api/desk/calls' })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: body.callId,
      status: 'waiting_human',
      queueKey: 'support',
    });
  });

  it('rejects bad embed keys, queues and origins', async () => {
    expect((await startCall({ origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await startCall({})).statusCode).toBe(403);
    const unknownQueue = await srv.app.inject({
      method: 'POST',
      url: '/api/public/calls',
      payload: { embedKey: publicKey, queue: 'nope' },
    });
    expect(unknownQueue.statusCode).toBe(404);
    const noKey = await srv.app.inject({ method: 'POST', url: '/api/public/calls', payload: {} });
    expect(noKey.statusCode).toBe(400);
  });

  it('accepts worker updates over the internal API and ends the room', async () => {
    const { callId, roomName } = (await startCall()).json();
    const base = `/api/internal/calls/${callId}`;
    expect((await srv.app.inject({ url: base })).statusCode).toBe(401);
    expect((await srv.app.inject({ url: base, headers: internal })).json().id).toBe(callId);
    expect(
      (await srv.app.inject({ url: '/api/internal/calls/nope', headers: internal })).statusCode,
    ).toBe(404);

    const transcripts: unknown[] = [];
    srv.hub.on('transcript', (e) => transcripts.push(e));
    const seg = await srv.app.inject({
      method: 'POST',
      url: `${base}/transcript`,
      headers: internal,
      payload: {
        speaker: 'ai',
        identity: 'agent',
        text: 'Hello, how can I help?',
        startMs: 0,
        endMs: 1200,
      },
    });
    expect(seg.statusCode).toBe(200);
    expect(transcripts).toHaveLength(1);
    const badSeg = await srv.app.inject({
      method: 'POST',
      url: `${base}/transcript`,
      headers: internal,
      payload: { text: '' },
    });
    expect(badSeg.statusCode).toBe(400);

    expect(
      (
        await srv.app.inject({
          method: 'POST',
          url: `${base}/participants`,
          headers: internal,
          payload: { kind: 'ai', identity: 'agent' },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await srv.app.inject({
          method: 'POST',
          url: `${base}/participants`,
          headers: internal,
          payload: { kind: 'ai', identity: 'agent', left: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await srv.app.inject({
          method: 'POST',
          url: `${base}/participants`,
          headers: internal,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await srv.app.inject({
          method: 'POST',
          url: `${base}/events`,
          headers: internal,
          payload: { type: 'escalation.requested', payload: { reason: 'billing' } },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await srv.app.inject({
          method: 'POST',
          url: `${base}/events`,
          headers: internal,
          payload: {},
        })
      ).statusCode,
    ).toBe(400);

    const ended = await srv.app.inject({
      method: 'POST',
      url: `${base}/status`,
      headers: internal,
      payload: { status: 'ended', summary: 'Customer asked about pricing.' },
    });
    expect(ended.json().status).toBe('ended');
    expect(srv.lk.deleted).toEqual([roomName]);
    const badStatus = await srv.app.inject({
      method: 'POST',
      url: `${base}/status`,
      headers: internal,
      payload: { status: 'nope' },
    });
    expect(badStatus.statusCode).toBe(400);

    const detail = (await srv.as(boss).inject({ url: `/api/desk/calls/${callId}` })).json();
    expect(detail.aiSummary).toBe('Customer asked about pricing.');
    expect(detail.endedAt).not.toBeNull();
    expect(detail.transcript).toHaveLength(1);
    expect(
      detail.participants.find((p: { kind: string }) => p.kind === 'ai').leftAt,
    ).not.toBeNull();
    expect(detail.events.map((e: { type: string }) => e.type)).toContain('escalation.requested');
  });

  it('answers 404 for unknown calls on every internal endpoint', async () => {
    for (const [path, payload] of [
      ['transcript', { speaker: 'ai', identity: 'a', text: 'x' }],
      ['events', { type: 't' }],
      ['participants', { kind: 'ai', identity: 'a' }],
      ['status', { status: 'ai' }],
    ] as const) {
      const res = await srv.app.inject({
        method: 'POST',
        url: `/api/internal/calls/nope/${path}`,
        headers: internal,
        payload,
      });
      expect(res.statusCode, path).toBe(404);
    }
    const { callId } = (await startCall()).json();
    const res = await srv.app.inject({
      method: 'POST',
      url: `/api/internal/calls/${callId}/status`,
      headers: internal,
      payload: { status: 'waiting_human' },
    });
    expect(res.json().status).toBe('waiting_human');
    expect(srv.lk.deleted).toEqual([]);
  });

  it('scopes desk history to the tenant', async () => {
    const { callId } = (await startCall()).json();
    const other = await createUser(db, 'other@example.com');
    await createTenant(db, 'Other', other.id);
    expect((await srv.as(other).inject({ url: `/api/desk/calls/${callId}` })).statusCode).toBe(404);
    expect((await srv.as(other).inject({ url: '/api/desk/calls' })).json()).toEqual([]);
    const nobody = await createUser(db, 'nobody@example.com');
    expect((await srv.as(nobody).inject({ url: '/api/desk/calls' })).statusCode).toBe(403);
  });
});
