import { DispatchMetadata } from '@cc/shared';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBus } from './bus.ts';
import type { Db } from './db/client.ts';
import { Flow } from './flow.ts';
import { fakeLiveKit } from './testing.ts';

/**
 * The persistence layer and the routing engine are mocked so these tests can reach the
 * defensive branches the database never produces: a call whose queue row is gone, an
 * accepting user that no longer exists, a human-first call deleted mid-ring. The happy
 * paths live in `flow.integration.test.ts`.
 */
const calls = vi.hoisted(() => ({
  getCall: vi.fn(),
  setCallStatus: vi.fn(),
  addEvent: vi.fn(async () => undefined),
  addParticipant: vi.fn(async () => undefined),
  markParticipantLeft: vi.fn(async () => undefined),
  setPreferredAgent: vi.fn(async () => undefined),
  setHeld: vi.fn(async (): Promise<Date | null> => null),
}));
vi.mock('./services/calls.ts', () => calls);
const tenants = vi.hoisted(() => ({ getTenant: vi.fn(async () => undefined as unknown) }));
vi.mock('./services/tenants.ts', () => tenants);

/** A `Routing` double that only records `offer` and exposes the callbacks it was given. */
const routing = vi.hoisted(() => ({
  events: null as null | {
    onAccepted: (c: string, u: string) => Promise<void>;
    onNobody: (c: string, t: string, f: unknown) => Promise<void>;
  },
  offer: vi.fn(async () => undefined),
  release: vi.fn(async () => undefined),
  busy: vi.fn(async () => undefined),
}));
vi.mock('./routing.ts', () => ({
  Routing: class {
    offer = routing.offer;
    release = routing.release;
    busy = routing.busy;
    stop() {}
    constructor(deps: { events: typeof routing.events }) {
      routing.events = deps.events;
    }
  },
}));

/**
 * Direct `db.select()` chains resolve to whatever the test pushed into `queueRows`
 * (empty by default: the queue row is gone), except the queue-member lookup
 * (`select({ userId })`), which returns `membersOf`.
 */
const membersOf: { userId: string }[] = [];
const queueRows: { config: Record<string, unknown> }[] = [];
const chain = (rows: () => unknown[]) => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where']) c[m] = () => c;
  c.then = (resolve: (rows: unknown[]) => void) => resolve(rows());
  return c;
};
const db = {
  select: (fields?: object) => chain(() => (fields ? membersOf : queueRows)),
} as unknown as Db;

const call = { id: 'c1', tenantId: 't1', queueId: 'q-gone', roomName: 'room', status: 'ai' };

describe('Flow (defensive branches)', () => {
  let flow: Flow;
  let hub: EventEmitter;
  let lk: ReturnType<typeof fakeLiveKit>;

  beforeEach(() => {
    vi.clearAllMocks();
    membersOf.length = 0;
    queueRows.length = 0;
    tenants.getTenant.mockResolvedValue(undefined);
    hub = new EventEmitter();
    lk = fakeLiveKit();
    flow = new Flow(db, lk.livekit, hub, new LocalBus(), 'test');
    calls.getCall.mockResolvedValue(call);
    calls.setCallStatus.mockResolvedValue(undefined);
  });

  it('derives routing inputs from the queue config and the contact fields', () => {
    const routingOf = (
      flow as unknown as {
        routingOf: (c: unknown, q: unknown) => unknown;
      }
    ).routingOf.bind(flow);
    expect(
      routingOf(
        // `de-CH` normalizes to the `lang:de` skill; `billing` is a queue skill and is
        // never relaxed even though the call pinned it too.
        {
          language: 'de-CH',
          requiredSkills: ['vip', 'billing'],
          preferredAgentId: 'u9',
          priority: 3,
        },
        {
          config: {
            algorithm: 'round_robin',
            requiredSkills: [{ skill: 'billing', min: 2 }],
            languageRouting: true,
            relaxAfterSec: 7,
          },
        },
      ),
    ).toEqual({
      algorithm: 'round_robin',
      skills: [
        { skill: 'billing', min: 2 },
        { skill: 'lang:de', min: 1 },
        { skill: 'vip', min: 1 },
      ],
      callSkills: ['lang:de', 'vip'],
      relaxAfterSec: 7,
      language: 'de-CH',
      preferredUserId: 'u9',
      priority: 3,
    });
    // language routing off, nothing pinned: bare defaults
    expect(
      routingOf({ language: null, requiredSkills: [], preferredAgentId: null }, undefined),
    ).toEqual({
      algorithm: 'longest_idle',
      skills: [],
      callSkills: [],
      relaxAfterSec: 20,
      priority: 0,
    });
  });

  it('sends the hold-music file with the hold command: queue first, then tenant', async () => {
    const bus = new LocalBus();
    const media: unknown[] = [];
    bus.subscribe((m) => m.kind === 'media' && media.push(m.command));
    flow = new Flow(db, lk.livekit, hub, bus, 'test');
    const tick = () => new Promise((r) => setTimeout(r, 0));

    // nothing configured: style only, no `music` key at all
    await flow.hold('c1');
    await tick();
    expect(media[0]).toEqual(expect.objectContaining({ action: 'moh.start', style: 'calm' }));
    expect(media[0]).not.toHaveProperty('music');

    // tenant-wide hold music
    tenants.getTenant.mockResolvedValue({
      settings: { sounds: { holdMusic: 'https://cdn.example.com/tenant.wav' } },
    });
    await flow.hold('c1');
    await tick();
    expect(media[1]).toMatchObject({ music: 'https://cdn.example.com/tenant.wav' });

    // the queue's own file wins, and its style travels too
    queueRows.push({ config: { moh: 'bright', holdMusicUrl: '/api/public/media/q1' } });
    await flow.hold('c1');
    await tick();
    expect(media[2]).toMatchObject({ music: '/api/public/media/q1', style: 'bright' });
    expect(calls.setHeld).toHaveBeenCalledTimes(3);
  });

  it('announces the hold state on the frame, and the retrieve before the music stops', async () => {
    const bus = new LocalBus();
    const order: string[] = [];
    bus.subscribe((m) => m.kind === 'media' && order.push(m.command.action));
    hub.on('call.updated', (u: { heldAt: string | null }) => order.push(`updated:${u.heldAt}`));
    flow = new Flow(db, lk.livekit, hub, bus, 'test');
    const tick = () => new Promise((r) => setTimeout(r, 0));

    const heldAt = new Date('2026-01-01T00:00:00.000Z');
    calls.setHeld.mockResolvedValueOnce(heldAt);
    await flow.hold('c1');
    await tick();
    expect(order).toEqual(['moh.start', `updated:${heldAt.toISOString()}`]);

    order.length = 0;
    calls.getCall.mockResolvedValue({ ...call, heldAt });
    await flow.unhold('c1');
    await tick();
    expect(order).toEqual(['updated:null', 'moh.stop']);
  });

  it('escalates with an empty queue key when the queue row is missing', async () => {
    const updated = vi.fn();
    hub.on('call.updated', updated);
    // nobody is online: the engine reports `nobody` from inside `offer`
    routing.offer.mockImplementationOnce(async () => {
      await routing.events!.onNobody('c1', 't1', null);
    });
    await expect(
      flow.escalate({
        callId: 'c1',
        reason: 'why',
        summary: 'what',
        ringSec: 7,
        skills: ['vip'],
        language: 'it',
      }),
    ).resolves.toEqual({ outcome: 'nobody' });
    expect(routing.offer).toHaveBeenCalledWith({
      callId: 'c1',
      tenantId: 't1',
      queueKey: '',
      reason: 'why',
      summary: 'what',
      ringSec: 7,
      members: [],
      algorithm: 'longest_idle',
      skills: [],
      callSkills: [],
      relaxAfterSec: 20,
      priority: 0,
    });
    expect(calls.addEvent.mock.calls.map((c) => c[2])).toEqual([
      'escalation.requested',
      'offer.nobody',
    ]);
    expect(calls.addEvent).toHaveBeenCalledWith(db, 'c1', 'escalation.requested', {
      reason: 'why',
      summary: 'what',
      skills: ['vip'],
      language: 'it',
    });
    // the status write found no row, so nothing was broadcast
    expect(updated).not.toHaveBeenCalled();
  });

  it('names the agent "a colleague" when the accepting user row is gone', async () => {
    membersOf.push({ userId: 'ghost' });
    routing.offer.mockImplementationOnce(async () => {
      await routing.events!.onAccepted('c1', 'ghost');
    });
    await expect(
      flow.escalate({ callId: 'c1', reason: 'r', summary: 's', ringSec: 5 }),
    ).resolves.toEqual({
      outcome: 'accepted',
      agentName: 'a colleague',
    });
    expect(calls.addEvent).toHaveBeenCalledWith(db, 'c1', 'offer.accepted', { userId: 'ghost' });
  });

  it('skips the AI dispatch when a human-first call vanished before the fallback', async () => {
    calls.getCall.mockResolvedValue(undefined);
    const fallback = DispatchMetadata.parse({
      callId: 'c2',
      tenantId: 't1',
      queueKey: 'support',
      settings: { routingMode: 'human-first' },
    });
    await flow.humanFirst('c2', fallback);
    expect(routing.offer).toHaveBeenCalledWith(expect.objectContaining({ callId: 'c2', fallback }));
    await routing.events!.onNobody('c2', 't1', fallback);
    expect(calls.setCallStatus).toHaveBeenCalledWith(db, 'c2', 'ai');
    expect(lk.calls.dispatched).toEqual([]);
    expect(calls.addEvent).toHaveBeenCalledWith(db, 'c2', 'offer.nobody');
    // ending an unknown call is a no-op
    await flow.end('c2');
    expect(routing.release).not.toHaveBeenCalled();
  });
});
