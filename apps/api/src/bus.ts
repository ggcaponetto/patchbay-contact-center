/**
 * Cross-instance message bus. With several API processes, the desk socket of an agent
 * lives on one of them while the routing tick that rings that agent may run on another;
 * everything that must reach "whoever holds the socket" (offers, presence snapshots,
 * escalation outcomes) goes through the bus instead of being sent directly.
 *
 * - {@link PgBus}: Postgres `LISTEN` / `NOTIFY` on the channel `cc_bus` — no extra
 *   infrastructure, millisecond latency, payloads are small JSON. Production.
 * - {@link LocalBus}: an in-process emitter with the same shape. Tests and single-process
 *   runs; also what `buildServer` uses when no bus is given.
 *
 * Messages are delivered to every instance including the publisher; handlers decide
 * whether they own the target.
 *
 * @see apps/api/src/README.md
 * @packageDocumentation
 */
import type { ServerMessage } from '@cc/shared';
import { EventEmitter } from 'node:events';
import pg from 'pg';

/** Everything that travels between API instances. */
export type BusMessage =
  /** Deliver a socket frame to one user, wherever their desks are. */
  | { kind: 'send'; userId: string; message: ServerMessage }
  /** Presence of a tenant changed; instances re-send the snapshot to that tenant's desks. */
  | { kind: 'presence'; tenantId: string }
  /** Deliver a socket frame to every desk of a tenant (presence, call.updated). */
  | { kind: 'tenant'; tenantId: string; message: ServerMessage }
  /** Deliver a socket frame to the desks subscribed to a call (transcript). */
  | { kind: 'call'; callId: string; message: ServerMessage }
  /** A ring cycle ended; the instance holding the escalation long-poll resolves it. */
  | { kind: 'offer'; callId: string; outcome: 'accepted' | 'nobody'; agentName?: string }
  /** Close every socket of a user (forced logout), wherever they are. */
  | { kind: 'logout'; userId: string; by: string };

/** What routing and the websocket need from a bus. */
export type Bus = {
  publish(message: BusMessage): Promise<void>;
  subscribe(handler: (message: BusMessage) => void): void;
  close(): Promise<void>;
};

/** In-process bus: delivery on the next tick, so publishers never re-enter handlers. */
export class LocalBus implements Bus {
  private readonly emitter = new EventEmitter();
  async publish(message: BusMessage): Promise<void> {
    queueMicrotask(() => this.emitter.emit('message', message));
  }
  subscribe(handler: (message: BusMessage) => void): void {
    this.emitter.on('message', handler);
  }
  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

const CHANNEL = 'cc_bus';

/**
 * Postgres-backed bus. One dedicated client keeps `LISTEN cc_bus` open; `publish` uses
 * `pg_notify` on a second connection (a notification is only delivered after the
 * publishing transaction commits, which is exactly the ordering routing needs).
 */
export class PgBus implements Bus {
  private readonly listener: pg.Client;
  private readonly publisher: pg.Client;
  private readonly handlers: ((m: BusMessage) => void)[] = [];

  /** @param connectionString - Same `DATABASE_URL` as the pool. */
  constructor(connectionString: string) {
    this.listener = new pg.Client({ connectionString });
    this.publisher = new pg.Client({ connectionString });
  }

  /** Connects both clients and starts listening. Call once at boot. */
  async start(): Promise<void> {
    await Promise.all([this.listener.connect(), this.publisher.connect()]);
    this.listener.on('notification', (n) => {
      if (n.channel !== CHANNEL || !n.payload) return;
      const message = JSON.parse(n.payload) as BusMessage;
      for (const h of this.handlers) h(message);
    });
    await this.listener.query(`LISTEN ${CHANNEL}`);
  }

  async publish(message: BusMessage): Promise<void> {
    await this.publisher.query('select pg_notify($1, $2)', [CHANNEL, JSON.stringify(message)]);
  }

  subscribe(handler: (message: BusMessage) => void): void {
    this.handlers.push(handler);
  }

  async close(): Promise<void> {
    await Promise.all([this.listener.end(), this.publisher.end()]);
  }
}
