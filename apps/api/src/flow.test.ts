import { DispatchMetadata } from '@cc/shared';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './db/client.ts';
import { Flow } from './flow.ts';
import { fakeLiveKit } from './testing.ts';

/**
 * The persistence layer is mocked so these tests can reach the defensive branches the
 * database never produces: a call whose queue row is gone, an accepting user that no
 * longer exists, a human-first call deleted mid-ring. The happy paths live in
 * `flow.integration.test.ts`.
 */
const calls = vi.hoisted(() => ({
  getCall: vi.fn(),
  setCallStatus: vi.fn(),
  addEvent: vi.fn(async () => undefined),
  addParticipant: vi.fn(async () => undefined),
  markParticipantLeft: vi.fn(async () => undefined),
}));
vi.mock('./services/calls.ts', () => calls);

/** Direct `db.select()` chains (queue and user lookups) resolve to no rows. */
const empty: Record<string, unknown> = {};
for (const m of ['select', 'from', 'where']) empty[m] = () => empty;
empty.then = (resolve: (rows: never[]) => void) => resolve([]);
const db = empty as unknown as Db;

const call = { id: 'c1', tenantId: 't1', queueId: 'q-gone', roomName: 'room', status: 'ai' };

describe('Flow (defensive branches)', () => {
  let flow: Flow;
  let hub: EventEmitter;
  let lk: ReturnType<typeof fakeLiveKit>;
  const sent: unknown[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    sent.length = 0;
    hub = new EventEmitter();
    lk = fakeLiveKit();
    flow = new Flow(db, lk.livekit, hub, (userId, m) => sent.push([userId, m]));
    calls.getCall.mockResolvedValue(call);
    calls.setCallStatus.mockResolvedValue(undefined);
  });

  it('escalates with an empty queue key when the queue row is missing', async () => {
    const offer = vi.spyOn(flow.routing, 'offer');
    const updated = vi.fn();
    hub.on('call.updated', updated);
    await expect(flow.escalate('c1', 'why', 'what', 7)).resolves.toEqual({ outcome: 'nobody' });
    expect(offer).toHaveBeenCalledWith({
      callId: 'c1',
      tenantId: 't1',
      queueKey: '',
      reason: 'why',
      summary: 'what',
      ringSec: 7,
    });
    expect(calls.addEvent.mock.calls.map((c) => c[2])).toEqual([
      'escalation.requested',
      'offer.nobody',
    ]);
    // the status write found no row, so nothing was broadcast
    expect(updated).not.toHaveBeenCalled();
  });

  it('names the agent "a colleague" when the accepting user row is gone', async () => {
    flow.routing.setPresence({
      userId: 'ghost',
      tenantId: 't1',
      name: 'Ghost',
      status: 'available',
      queues: [''],
    });
    const outcome = flow.escalate('c1', 'r', 's', 5);
    await vi.waitFor(() => expect(flow.routing.ringing('c1')).toBe('ghost'));
    expect(flow.routing.accept('c1', 'ghost')).toBe(true);
    await expect(outcome).resolves.toEqual({ outcome: 'accepted', agentName: 'a colleague' });
  });

  it('skips the AI dispatch when a human-first call vanished before the fallback', async () => {
    calls.getCall.mockResolvedValue(undefined);
    const fallback = DispatchMetadata.parse({
      callId: 'c2',
      tenantId: 't1',
      queueKey: 'support',
      settings: { routingMode: 'human-first' },
    });
    flow.humanFirst('c2', fallback);
    await vi.waitFor(() => expect(calls.setCallStatus).toHaveBeenCalledWith(db, 'c2', 'ai'));
    expect(lk.calls.dispatched).toEqual([]);
    expect(calls.addEvent).toHaveBeenCalledWith(db, 'c2', 'offer.nobody');
  });
});
