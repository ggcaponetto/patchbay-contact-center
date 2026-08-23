/**
 * Desk websocket (`/api/ws`): the push channel from the API to signed-in agents and
 * supervisors. REST is used for anything that returns data (accepting an offer returns a
 * LiveKit token); the socket carries only what must arrive unprompted.
 *
 * Message contracts are the zod schemas `ClientMessage` / `ServerMessage` in `@cc/shared`.
 *
 * Server → client: `presence`, `call.offer`, `call.offer.cancelled`, `call.updated`,
 * `transcript`, `logout`. Client → server: `subscribe`, `offer.decline` (agent states are
 * set over REST, `routes/desk.ts`).
 *
 * Sources of outgoing messages:
 *
 * - `Routing` sends `call.offer` / `call.offer.cancelled` to one user via `Flow`'s
 *   `sendToUser`, which is {@link DeskSockets.toUser}.
 * - The event hub: `presence` and `call.updated` are broadcast to the tenant,
 *   `transcript` only to sockets that `subscribe`d to that call.
 *
 * @see apps/api/src/README.md
 * @packageDocumentation
 */
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
import { DEV_USER_HEADER, type GetSession } from './auth.ts';
import type { Bus } from './bus.ts';
import type { Db } from './db/client.ts';
import type { Flow } from './flow.ts';
import { getTenant, membershipsOf } from './services/tenants.ts';

/** One open desk socket. A user may have several (tabs); presence is per user. */
type Conn = { socket: WebSocket; userId: string; tenantId: string; subscribed: Set<string> };

/**
 * Fan-out of server messages to the desks connected to **this** instance. Anything that
 * must reach a desk wherever it is goes through the {@link Bus}: `registerWs` subscribes
 * and turns `send` / `tenant` / `call` / `presence` / `logout` bus messages into socket
 * frames for the connections it holds.
 *
 * Pure bookkeeping over a `Set<Conn>`; it does not know about authentication or routing.
 */
export class DeskSockets {
  private readonly conns = new Set<Conn>();
  /** The cross-instance bus; routes publish on it to reach desks on other instances. */
  readonly bus: Bus;

  constructor(bus: Bus) {
    this.bus = bus;
  }

  /** Registers an authenticated connection. */
  add(conn: Conn): void {
    this.conns.add(conn);
  }
  /**
   * Unregisters a connection.
   * @returns `true` while the same user still has another socket open, so the caller
   *   knows whether to drop the user's presence.
   */
  remove(conn: Conn): boolean {
    this.conns.delete(conn);
    return [...this.conns].some((c) => c.userId === conn.userId);
  }
  /** Sends to every socket of one user (offers, cancellations). */
  toUser(userId: string, message: ServerMessage): void {
    this.each((c) => c.userId === userId, message);
  }
  /** Sends to every socket of a tenant (presence, call status changes). */
  toTenant(tenantId: string, message: ServerMessage): void {
    this.each((c) => c.tenantId === tenantId, message);
  }
  /** Closes every socket of a user (forced logout); the desk stops reconnecting. */
  closeUser(userId: string, by: string): void {
    for (const c of [...this.conns]) {
      if (c.userId !== userId) continue;
      c.socket.send(JSON.stringify({ type: 'logout', by } satisfies ServerMessage));
      c.socket.close(4403, 'logged_out');
    }
  }
  /** Sends to sockets that subscribed to the call (live transcript). */
  toSubscribers(callId: string, message: ServerMessage): void {
    this.each((c) => c.subscribed.has(callId), message);
  }
  private each(pick: (c: Conn) => boolean, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const c of this.conns) if (pick(c)) c.socket.send(data);
  }
}

/** Dependencies of {@link registerWs}; `server.ts` provides them. */
export type WsDeps = {
  db: Db;
  getSession: GetSession;
  flow: Flow;
  hub: EventEmitter;
  sockets: DeskSockets;
};

/**
 * `/api/ws`: presence, ring offers, live call updates and transcripts for the desk.
 *
 * Connection lifecycle:
 *
 * 1. Upgrade. The session cookie is resolved with `getSession`; `?tenantId=` picks the
 *    membership (first one otherwise). No session or membership: close `4401`.
 * 2. The connection is registered and presence starts as `not_ready` until the desk
 *    asks for a state over `POST /api/desk/state`.
 * 3. Client messages are parsed with `ClientMessage`; invalid JSON or unknown shapes are
 *    silently dropped.
 * 4. On close the connection is removed; presence is dropped only when the user has no
 *    other socket left (which also moves any offer ringing them to the next agent).
 *
 * @param app - Fastify instance; the `@fastify/websocket` plugin is registered here.
 * @param deps - See {@link WsDeps}.
 */
export async function registerWs(app: FastifyInstance, deps: WsDeps): Promise<void> {
  const { db, getSession, flow, hub, sockets } = deps;
  await app.register(websocket);

  // Hub events are this instance's; republish them on the bus so every instance's desks
  // get them, then deliver bus messages to the sockets held here.
  hub.on(
    'call.updated',
    ({ tenantId, callId, status }: { tenantId: string; callId: string; status: CallStatus }) =>
      void sockets.bus.publish({
        kind: 'tenant',
        tenantId,
        message: { type: 'call.updated', callId, status },
      }),
  );
  hub.on(
    'transcript',
    ({ callId, segment }: { callId: string; segment: TranscriptSegmentInput }) =>
      void sockets.bus.publish({
        kind: 'call',
        callId,
        message: { type: 'transcript', callId, segment },
      }),
  );
  sockets.bus.subscribe((m) => {
    switch (m.kind) {
      case 'send':
        return sockets.toUser(m.userId, m.message);
      case 'tenant':
        return sockets.toTenant(m.tenantId, m.message);
      case 'call':
        return sockets.toSubscribers(m.callId, m.message);
      case 'presence':
        return void flow.routing
          .snapshot(m.tenantId)
          .then((agents) => sockets.toTenant(m.tenantId, { type: 'presence', agents }))
          .catch(() => undefined);
      case 'logout':
        return sockets.closeUser(m.userId, m.by);
      case 'offer':
        return undefined;
    }
  });

  app.get('/api/ws', { websocket: true }, async (socket, request) => {
    // Buffer client messages until the session is resolved; `ws` drops messages
    // that arrive while no listener is attached. A desk typically sends `status`
    // immediately after `open`, before the `await`s below have finished.
    const inbox: { early: string[]; handle?: (raw: string) => void } = { early: [] };
    socket.on('message', (raw) =>
      inbox.handle ? inbox.handle(String(raw)) : inbox.early.push(String(raw)),
    );

    // Browsers cannot set headers on a websocket upgrade, so the desk passes its dev
    // identity as `?as=`; folded into the headers it is just the `x-dev-user` header
    // (honored by `devAuth`, meaningless under Better Auth).
    const { tenantId, as } = request.query as { tenantId?: string; as?: string };
    const user = await getSession(
      typeof as === 'string' && as !== ''
        ? { ...request.headers, [DEV_USER_HEADER]: as }
        : request.headers,
    );
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
    socket.on('close', () => {
      const stillConnected = sockets.remove(conn);
      if (!stillConnected) void flow.routing.disconnect(user.id).catch(() => undefined);
    });
    await flow.routing.connect({ userId: user.id, tenantId: membership.tenantId, name: user.name });
    // A late joiner still sees the tenant-wide ticker banner: push the current one.
    const tenant = await getTenant(db, membership.tenantId);
    if (tenant && tenant.settings.ticker !== '') {
      socket.send(
        JSON.stringify({ type: 'ticker', text: tenant.settings.ticker } satisfies ServerMessage),
      );
    }

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
        case 'subscribe':
          conn.subscribed.add(msg.callId);
          break;
        case 'offer.decline':
          void flow.routing.decline(msg.callId, user.id).catch(() => undefined);
          break;
      }
    };
    // Replay whatever arrived while we were authenticating, in order.
    inbox.early.forEach(inbox.handle);
  });
}
