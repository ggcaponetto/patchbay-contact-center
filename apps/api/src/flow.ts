/**
 * Call-flow orchestrator: the glue between `Routing` (ringing, in Postgres), the database
 * (`services/calls.ts`) and LiveKit (tokens, agent dispatch, room teardown).
 *
 * Where it sits: routes call into `Flow`; `Flow` drives `Routing` and reacts to its
 * callbacks; every status change is persisted and then announced on the event hub so the
 * websocket can push `call.updated` to desks (on every API instance, through the bus).
 *
 * Two entry points start a ring cycle:
 *
 * - {@link Flow.escalate}: the AI (via `POST /api/internal/calls/:id/escalate`) wants a
 *   human. The HTTP request is held open (long-poll) until an {@link Outcome} is known.
 * - {@link Flow.humanFirst}: a `human-first` tenant received a new call. Humans ring
 *   first; if nobody answers within `humanFirstTimeoutSec`, the AI agent is dispatched.
 *
 * `escalate` registers a `Waiter` keyed by call id on the instance holding the HTTP
 * request. The ring cycle may end on any instance: `accepted` / `nobody` run there, do
 * the database work once, and publish an `offer` bus message that resolves the waiter
 * wherever it is. `end` publishes `nobody` too, so an escalation never hangs when the
 * customer hangs up mid-ring.
 *
 * @see apps/api/src/README.md
 * @packageDocumentation
 */
import type { DispatchMetadata } from '@cc/shared';
import { eq } from 'drizzle-orm';
import type { EventEmitter } from 'node:events';
import type { Bus } from './bus.ts';
import type { Db } from './db/client.ts';
import { queue, queueMember, user } from './db/schema.ts';
import type { LiveKit } from './livekit.ts';
import { Routing } from './routing.ts';
import {
  addEvent,
  addParticipant,
  getCall,
  markParticipantLeft,
  setCallStatus,
} from './services/calls.ts';
import { getTenant } from './services/tenants.ts';

/**
 * Result of a ring cycle, returned to the AI agent worker by the escalation long-poll.
 * `agentName` lets the AI tell the caller who is joining.
 */
export type Outcome = { outcome: 'accepted'; agentName: string } | { outcome: 'nobody' };

/** A pending escalation long-poll on this instance. */
type Waiter = { resolve: (o: Outcome) => void };

/**
 * Ties routing to persistence and LiveKit: escalations, human-first ringing,
 * accept / take-over tokens. One instance per API process.
 *
 * Hub events emitted: `presence` (`{ tenantId }`) whenever presence changes, and
 * `call.updated` (`{ tenantId, callId, status }`) after every status write.
 */
export class Flow {
  /** The router; `ws.ts` feeds it presence, desk routes call `accept` / `decline`. */
  readonly routing: Routing;
  private readonly waiters = new Map<string, Waiter>();
  private readonly db: Db;
  private readonly livekit: LiveKit;
  private readonly hub: EventEmitter;
  private readonly bus: Bus;

  /**
   * @param db - Drizzle client.
   * @param livekit - Real or fake LiveKit, see `livekit.ts`.
   * @param hub - In-process event bus shared with routes and the websocket.
   * @param bus - Cross-instance bus; `Routing` rings through it and outcomes travel on it.
   * @param instanceId - This API process, for `agent_presence.instance_id`.
   */
  constructor(db: Db, livekit: LiveKit, hub: EventEmitter, bus: Bus, instanceId: string) {
    this.db = db;
    this.livekit = livekit;
    this.hub = hub;
    this.bus = bus;
    this.routing = new Routing({
      db,
      bus,
      instanceId,
      events: {
        onAccepted: (callId, userId) => this.accepted(callId, userId),
        onNobody: (callId, _tenantId, fallback) => this.nobody(callId, fallback),
      },
    });
    bus.subscribe((m) => {
      if (m.kind !== 'offer') return;
      const waiter = this.waiters.get(m.callId);
      this.waiters.delete(m.callId);
      waiter?.resolve(
        m.outcome === 'accepted'
          ? { outcome: 'accepted', agentName: m.agentName ?? 'a colleague' }
          : { outcome: 'nobody' },
      );
    });
  }

  /**
   * The AI asked for a human. Resolves when someone accepted or nobody could.
   *
   * Side effects before ringing: records an `escalation.requested` event and moves the
   * call to `waiting_human`. Resolves immediately with `nobody` for unknown or ended calls.
   *
   * @param callId - Call the AI is on.
   * @param reason - Why the AI escalates; shown to the ringing agent.
   * @param summary - What was said so far; shown to the ringing agent.
   * @param ringSec - Seconds each agent rings before the next one is tried.
   * @returns Resolves with the {@link Outcome}; never rejects.
   */
  async escalate(
    callId: string,
    reason: string,
    summary: string,
    ringSec: number,
  ): Promise<Outcome> {
    const call = await getCall(this.db, callId);
    if (!call || call.status === 'ended') return { outcome: 'nobody' };
    const [q] = await this.db.select().from(queue).where(eq(queue.id, call.queueId));
    const members = await this.queueMembers(call.queueId);
    await addEvent(this.db, callId, 'escalation.requested', { reason, summary });
    await this.status(callId, 'waiting_human');
    return new Promise<Outcome>((resolve) => {
      // The waiter must exist before `offer` runs: with no agents online, `onNobody`
      // fires inside `offer`.
      this.waiters.set(callId, { resolve });
      void this.routing.offer({
        callId,
        tenantId: call.tenantId,
        queueKey: q?.key ?? '',
        reason,
        summary,
        ringSec,
        members,
      });
    });
  }

  /** User ids belonging to the queue, read fresh so Settings changes apply immediately. */
  private async queueMembers(queueId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: queueMember.userId })
      .from(queueMember)
      .where(eq(queueMember.queueId, queueId));
    return rows.map((r) => r.userId);
  }

  /**
   * Human-first: ring the queue; if nobody picks up in time, dispatch the AI with `fallback`.
   *
   * Fire-and-forget: the public route returns the customer's token right away while the
   * desks ring. Ring timings come from the tenant settings carried in `fallback`.
   *
   * @param callId - The freshly created call.
   * @param fallback - Dispatch metadata for the AI agent, used only if nobody answers.
   */
  async humanFirst(callId: string, fallback: DispatchMetadata): Promise<void> {
    const call = await getCall(this.db, callId);
    const members = call ? await this.queueMembers(call.queueId) : [];
    await this.routing.offer({
      callId,
      tenantId: fallback.tenantId,
      queueKey: fallback.queueKey,
      giveUpAfterSec: fallback.settings.humanFirstTimeoutSec,
      ringSec: fallback.settings.offerTimeoutSec,
      members,
      fallback,
    });
  }

  /**
   * Mints a token for the accepting agent (or a supervisor taking over / listening).
   *
   * - `agent`: the human who accepted the offer; call becomes `human`.
   * - `takeover`: a supervisor joins as a full participant; call becomes `human`.
   * - `listen`: a supervisor joins subscribe-only (`canPublish: false`); status unchanged.
   *
   * Also records the participant row and a `<mode>.joined` event. Does **not** check
   * that the user was actually rung: desk routes do that through `routing.accept`.
   *
   * @returns `{ token, url }` for the LiveKit client, or `undefined` if the call is
   *   unknown or already ended (routes answer 409 `call_over`).
   */
  async join(
    callId: string,
    u: { id: string; name: string },
    mode: 'agent' | 'takeover' | 'listen',
  ): Promise<{ token: string; url: string } | undefined> {
    const call = await getCall(this.db, callId);
    if (!call || call.status === 'ended') return undefined;
    const role = mode === 'listen' ? 'supervisor' : 'human';
    const identity = `${role}:${u.id}`;
    const token = await this.livekit.createToken({
      room: call.roomName,
      identity,
      name: u.name,
      attributes: { role, userId: u.id, displayName: u.name },
      canPublish: mode !== 'listen',
    });
    await addParticipant(this.db, { callId, kind: role, identity, userId: u.id });
    await addEvent(this.db, callId, `${mode}.joined`, { userId: u.id, name: u.name });
    // `accept` already marked the agent busy; a take-over marks the supervisor.
    if (mode === 'takeover') await this.routing.busy(callId, u.id);
    if (mode !== 'listen') await this.status(callId, 'human');
    return { token, url: this.livekit.url };
  }

  /**
   * A desk participant left the call. The human agent leaving ends the call.
   *
   * `release` frees the agent in the router (into wrap-up, see the private `release`) even
   * when the leaver is a supervisor, because the router keys agents by call id, not by role.
   *
   * @param role - Which identity left: `human:<id>` or `supervisor:<id>`.
   */
  async leave(callId: string, u: { id: string }, role: 'human' | 'supervisor'): Promise<void> {
    await markParticipantLeft(this.db, callId, `${role}:${u.id}`);
    await addEvent(this.db, callId, `${role}.left`, { userId: u.id });
    await this.release(callId);
    if (role === 'human') await this.end(callId);
  }

  /**
   * Frees whoever is on the call in the router: they enter after-call work for the
   * tenant's `acwSec` (straight to `ready` when it is `0`).
   */
  private async release(callId: string): Promise<void> {
    const call = await getCall(this.db, callId);
    const tenant = call ? await getTenant(this.db, call.tenantId) : undefined;
    await this.routing.release(callId, { acwSec: tenant?.settings.acwSec ?? 0 });
  }

  /**
   * Marks the call ended and tears the room down (idempotent).
   *
   * Order: delete the LiveKit room (disconnects customer, AI and desks), persist `ended`,
   * stop any ringing and free the agent, then resolve a pending escalation with `nobody`.
   * Called by `leave` (human hung up) and by the internal status route (AI ended the call).
   */
  async end(callId: string): Promise<void> {
    const call = await getCall(this.db, callId);
    if (!call || call.status === 'ended') return;
    await this.livekit.deleteRoom(call.roomName);
    await this.status(callId, 'ended');
    await this.release(callId);
    await this.bus.publish({ kind: 'offer', callId, outcome: 'nobody' });
  }

  /** `Routing.onAccepted`: record the event and hand the agent's name to the waiter. */
  private async accepted(callId: string, userId: string): Promise<void> {
    const [u] = await this.db.select().from(user).where(eq(user.id, userId));
    await addEvent(this.db, callId, 'offer.accepted', { userId });
    await this.bus.publish({
      kind: 'offer',
      callId,
      outcome: 'accepted',
      agentName: u?.name ?? 'a colleague',
    });
  }

  /**
   * `Routing.onNobody`: the cycle ended without an acceptance. For human-first calls this
   * is where the AI gets dispatched (`fallback` came with the offer); either way the call
   * goes (back) to `ai`.
   */
  private async nobody(callId: string, fallback: Record<string, unknown> | null): Promise<void> {
    await addEvent(this.db, callId, 'offer.nobody');
    if (fallback) {
      const call = await getCall(this.db, callId);
      if (call) await this.livekit.dispatchAgent(call.roomName, JSON.stringify(fallback));
    }
    await this.status(callId, 'ai');
    await this.bus.publish({ kind: 'offer', callId, outcome: 'nobody' });
  }

  /** Persists the status and broadcasts `call.updated` to the tenant's desks. */
  private async status(
    callId: string,
    status: 'waiting_human' | 'human' | 'ai' | 'ended',
  ): Promise<void> {
    const row = await setCallStatus(this.db, callId, status);
    if (row) this.hub.emit('call.updated', { tenantId: row.tenantId, callId, status });
  }
}
