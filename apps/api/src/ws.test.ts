import type { ServerMessage } from '@cc/shared';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { DeskSockets } from './ws.ts';

/** A connection whose socket records what it was sent. */
function conn(userId: string, tenantId: string, subscribed: string[] = []) {
  const sent: ServerMessage[] = [];
  const socket = { send: (data: string) => sent.push(JSON.parse(data)) } as unknown as WebSocket;
  return { conn: { socket, userId, tenantId, subscribed: new Set(subscribed) }, sent };
}

describe('DeskSockets', () => {
  const presence: ServerMessage = { type: 'presence', agents: [] };
  const updated: ServerMessage = { type: 'call.updated', callId: 'c1', status: 'human' };
  const transcript: ServerMessage = {
    type: 'transcript',
    callId: 'c1',
    segment: { speaker: 'customer', identity: 'customer:c1', text: 'hi' },
  };

  it('fans out by user, tenant and subscription', () => {
    const sockets = new DeskSockets();
    const a1 = conn('a', 't1', ['c1']);
    const a2 = conn('a', 't1');
    const b = conn('b', 't2', ['c1']);
    for (const c of [a1, a2, b]) sockets.add(c.conn);

    sockets.toUser('a', presence);
    expect(a1.sent).toEqual([presence]);
    expect(a2.sent).toEqual([presence]);
    expect(b.sent).toEqual([]);

    sockets.toTenant('t2', updated);
    expect(b.sent).toEqual([updated]);
    expect(a1.sent).toHaveLength(1);

    sockets.toSubscribers('c1', transcript);
    expect(a1.sent.at(-1)).toEqual(transcript);
    expect(a2.sent).toHaveLength(1);
    expect(b.sent.at(-1)).toEqual(transcript);
  });

  it('reports whether a user still has another socket after removal', () => {
    const sockets = new DeskSockets();
    const a1 = conn('a', 't1');
    const a2 = conn('a', 't1');
    sockets.add(a1.conn);
    sockets.add(a2.conn);
    expect(sockets.remove(a1.conn)).toBe(true);
    expect(sockets.remove(a2.conn)).toBe(false);
    sockets.toUser('a', presence);
    expect(a1.sent).toEqual([]);
    expect(a2.sent).toEqual([]);
  });
});
