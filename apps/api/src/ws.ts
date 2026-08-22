import {
  type CallStatus,
  ClientMessage,
  type ServerMessage,
  type TranscriptSegmentInput,
} from '@cc/shared';
import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import type { GetSession } from './auth.ts';
import type { Db } from './db/client.ts';
import type { Flow } from './flow.ts';
import { membershipsOf, queuesOfUser } from './services/tenants.ts';

type Conn = { socket: WebSocket; userId: string; tenantId: string; subscribed: Set<string> };

/** Fan-out of server messages to connected desks; also what `Flow` uses to ring agents. */
export class DeskSockets {
  private readonly conns = new Set<Conn>();

  add(conn: Conn): void {
    this.conns.add(conn);
  }
  remove(conn: Conn): boolean {
    this.conns.delete(conn);
    return [...this.conns].some((c) => c.userId === conn.userId);
  }
  toUser(userId: string, message: ServerMessage): void {
    this.each((c) => c.userId === userId, message);
  }
  toTenant(tenantId: string, message: ServerMessage): void {
    this.each((c) => c.tenantId === tenantId, message);
  }
  toSubscribers(callId: string, message: ServerMessage): void {
    this.each((c) => c.subscribed.has(callId), message);
  }
  private each(pick: (c: Conn) => boolean, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const c of this.conns) if (pick(c)) c.socket.send(data);
  }
}

export type WsDeps = {
  db: Db;
  getSession: GetSession;
  flow: Flow;
  hub: EventEmitter;
  sockets: DeskSockets;
};

/** `/api/ws`: presence, ring offers, live call updates and transcripts for the desk. */
export async function registerWs(app: FastifyInstance, deps: WsDeps): Promise<void> {
  const { db, getSession, flow, hub, sockets } = deps;
  await app.register(websocket);

  const presenceMessage = (tenantId: string): ServerMessage => ({
    type: 'presence',
    agents: flow.routing.snapshot(tenantId).map((a) => ({
      userId: a.userId,
      name: a.name,
      status: a.status,
      callId: a.callId,
    })),
  });
  hub.on('presence', ({ tenantId }: { tenantId: string }) =>
    sockets.toTenant(tenantId, presenceMessage(tenantId)),
  );
  hub.on(
    'call.updated',
    ({ tenantId, callId, status }: { tenantId: string; callId: string; status: CallStatus }) =>
      sockets.toTenant(tenantId, { type: 'call.updated', callId, status }),
  );
  hub.on('transcript', ({ callId, segment }: { callId: string; segment: TranscriptSegmentInput }) =>
    sockets.toSubscribers(callId, { type: 'transcript', callId, segment }),
  );

  app.get('/api/ws', { websocket: true }, async (socket, request) => {
    // Buffer client messages until the session is resolved; `ws` drops messages
    // that arrive while no listener is attached.
    const inbox: { early: string[]; handle?: (raw: string) => void } = { early: [] };
    socket.on('message', (raw) =>
      inbox.handle ? inbox.handle(String(raw)) : inbox.early.push(String(raw)),
    );

    const user = await getSession(request.headers);
    const tenantId = (request.query as { tenantId?: string }).tenantId;
    const membership = user
      ? (await membershipsOf(db, user.id)).find((m) => !tenantId || m.tenantId === tenantId)
      : undefined;
    if (!user || !membership) {
      socket.close(4401, 'unauthenticated');
      return;
    }
    const conn: Conn = {
      socket,
      userId: user.id,
      tenantId: membership.tenantId,
      subscribed: new Set(),
    };
    sockets.add(conn);
    const queues = (await queuesOfUser(db, membership.tenantId, user.id)).map((q) => q.key);
    const presence = (status: 'available' | 'busy' | 'away') =>
      flow.routing.setPresence({
        userId: user.id,
        tenantId: membership.tenantId,
        name: user.name,
        status,
        queues,
      });

    socket.on('close', () => {
      const stillConnected = sockets.remove(conn);
      if (!stillConnected) flow.routing.removePresence(user.id);
    });
    presence('away');

    inbox.handle = (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return;
      }
      const parsed = ClientMessage.safeParse(json);
      if (!parsed.success) return;
      const msg = parsed.data;
      switch (msg.type) {
        case 'status':
          presence(msg.status);
          break;
        case 'subscribe':
          conn.subscribed.add(msg.callId);
          break;
        case 'offer.decline':
          flow.routing.decline(msg.callId, user.id);
          break;
      }
    };
    inbox.early.forEach(inbox.handle);
  });
}
