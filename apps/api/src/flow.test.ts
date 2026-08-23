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
}));
vi.mock('./services/calls.ts', () => calls);
vi.mock('./services/tenants.ts', () => ({ getTenant: async () => undefined }));

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
 * Direct `db.select()` chains resolve to no rows, except the queue-member lookup
 * (`select({ userId })`), which returns whatever the test pushed into `membersOf`.
 */
const membersOf: { userId: string }[] = [];
const chain = (rows: () => unknown[]) => {
  const c: Record<string, unknown> = {};
  for (const m of ['from', 'where']) c[m] = () => c;
  c.then = (resolve: (rows: unknown[]) => void) => resolve(rows());
  return c;
};
const db = {
  select: (fields?: object) => chain(() => (fields ? membersOf : [])),
} as unknown as Db;

const call = { id: 'c1', tenantId: 't1', queueId: 'q-gone', roomName: 'room', status: 'ai' };

describe('Flow (defensive branches)', () => {
  let flow: Flow;
  let hub: EventEmitter;
  let lk: ReturnType<typeof fakeLiveKit>;

  beforeEach(() => {
    vi.clearAllMocks();
    membersOf.length = 0;
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
        { language: 'de', requiredSkills: ['vip'], preferredAgentId: 'u9', priority: 3 },
        {
          config: {
            algorithm: 'round_robin',
            requiredSkills: [{ skill: 'billing', min: 2 }],
            languageRouting: true,
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
      preferredUserId: 'u9',
      priority: 3,
    });
    // language routing off, nothing pinned: bare defaults
    expect(
      routingOf({ language: 'de', requiredSkills: [], preferredAgentId: null }, undefined),
    ).toEqual({
      algorithm: 'longest_idle',
      skills: [],
      priority: 0,
    });
  });

  it('escalates with an empty queue key when the queue row is missing', async () => {
    const updated = vi.fn();
    hub.on('call.updated', updated);
    // nobody is online: the engine reports `nobody` from inside `offer`
    routing.offer.mockImplementationOnce(async () => {
      await routing.events!.onNobody('c1', 't1', null);
    });
    await expect(flow.escalate('c1', 'why', 'what', 7)).resolves.toEqual({ outcome: 'nobody' });
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
      priority: 0,
    });
    expect(calls.addEvent.mock.calls.map((c) => c[2])).toEqual([
      'escalation.requested',
      'offer.nobody',
    ]);
    // the status write found no row, so nothing was broadcast
    expect(updated).not.toHaveBeenCalled();
  });

  it('names the agent "a colleague" when the accepting user row is gone', async () => {
    membersOf.push({ userId: 'ghost' });
    routing.offer.mockImplementationOnce(async () => {
      await routing.events!.onAccepted('c1', 'ghost');
    });
    await expect(flow.escalate('c1', 'r', 's', 5)).resolves.toEqual({
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
