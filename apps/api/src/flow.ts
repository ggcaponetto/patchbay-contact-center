/**
 * Call-flow orchestrator: the glue between `Routing` (in-memory ringing), the database
 * (`services/calls.ts`) and LiveKit (tokens, agent dispatch, room teardown).
 *
 * Where it sits: routes call into `Flow`; `Flow` drives `Routing` and reacts to its
 * callbacks; every status change is persisted and then announced on the event hub so the
 * websocket can push `call.updated` to desks.
 *
 * Two entry points start a ring cycle:
 *
 * - {@link Flow.escalate}: the AI (via `POST /api/internal/calls/:id/escalate`) wants a
 *   human. The HTTP request is held open (long-poll) until an {@link Outcome} is known.
 * - {@link Flow.humanFirst}: a `human-first` tenant received a new call. Humans ring
 *   first; if nobody answers within `humanFirstTimeoutSec`, the AI agent is dispatched.
 *
 * Both register a `Waiter` keyed by call id. `Routing` later calls `accepted` or `nobody`,
 * which resolves the waiter exactly once and cleans it up. `end` also resolves any pending
 * waiter with `nobody` so an escalation never hangs when the customer hangs up mid-ring.
 *
 * @see apps/api/src/README.md
 * @packageDocumentation
 */
import type { DispatchMetadata, ServerMessage } from '@cc/shared';
import { eq } from 'drizzle-orm';
import type { EventEmitter } from 'node:events';
import type { Db } from './db/client.ts';
import { queue, user } from './db/schema.ts';
import type { LiveKit } from './livekit.ts';
import { Routing } from './routing.ts';
import {
  addEvent,
  addParticipant,
  getCall,
  markParticipantLeft,
  setCallStatus,
} from './services/calls.ts';

/**
 * Result of a ring cycle, returned to the AI agent worker by the escalation long-poll.
 * `agentName` lets the AI tell the caller who is joining.
 */
export type Outcome = { outcome: 'accepted'; agentName: string } | { outcome: 'nobody' };

/**
 * A pending ring cycle. `resolve` completes the escalation promise (a no-op for
 * human-first). `fallback` is set only for human-first: the dispatch metadata to start
 * the AI with when nobody answers.
 */
type Waiter = { resolve: (o: Outcome) => void; fallback?: DispatchMetadata };

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

  /**
   * @param db - Drizzle client.
   * @param livekit - Real or fake LiveKit, see `livekit.ts`.
   * @param hub - In-process event bus shared with routes and the websocket.
   * @param sendToUser - How to reach a desk user; `server.ts` passes `DeskSockets.toUser`.
   */
  constructor(
    db: Db,
    livekit: LiveKit,
    hub: EventEmitter,
    sendToUser: (userId: string, m: ServerMessage) => void,
  ) {
    this.db = db;
    this.livekit = livekit;
    this.hub = hub;
    this.routing = new Routing({
      send: sendToUser,
      presenceChanged: (tenantId) => hub.emit('presence', { tenantId }),
      onAccepted: (callId, userId) => void this.accepted(callId, userId),
      onNobody: (callId) => void this.nobody(callId),
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
    await addEvent(this.db, callId, 'escalation.requested', { reason, summary });
    await this.status(callId, 'waiting_human');
    return new Promise<Outcome>((resolve) => {
      // The waiter must exist before `offer` runs: with no agents online, `onNobody`
      // fires synchronously inside `offer`.
      this.waiters.set(callId, { resolve });
      this.routing.offer({
        callId,
        tenantId: call.tenantId,
        queueKey: q?.key ?? '',
        reason,
        summary,
        ringSec,
      });
    });
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
  humanFirst(callId: string, fallback: DispatchMetadata): void {
    this.waiters.set(callId, { resolve: () => undefined, fallback });
    this.routing.offer({
      callId,
      tenantId: fallback.tenantId,
      queueKey: fallback.queueKey,
      giveUpAfterSec: fallback.settings.humanFirstTimeoutSec,
      ringSec: fallback.settings.offerTimeoutSec,
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
    if (mode !== 'listen') await this.status(callId, 'human');
    return { token, url: this.livekit.url };
  }

  /**
   * A desk participant left the call. The human agent leaving ends the call.
   *
   * `release` frees the agent in the router (status back to `available`) even when the
   * leaver is a supervisor, because the router keys agents by call id, not by role.
   *
   * @param role - Which identity left: `human:<id>` or `supervisor:<id>`.
   */
  async leave(callId: string, u: { id: string }, role: 'human' | 'supervisor'): Promise<void> {
    await markParticipantLeft(this.db, callId, `${role}:${u.id}`);
    await addEvent(this.db, callId, `${role}.left`, { userId: u.id });
    this.routing.release(callId);
    if (role === 'human') await this.end(callId);
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
    this.routing.release(callId);
    this.waiters.get(callId)?.resolve({ outcome: 'nobody' });
    this.waiters.delete(callId);
  }

  /** `Routing.onAccepted`: record the event and hand the agent's name to the waiter. */
  private async accepted(callId: string, userId: string): Promise<void> {
    const [u] = await this.db.select().from(user).where(eq(user.id, userId));
    await addEvent(this.db, callId, 'offer.accepted', { userId });
    this.waiters.get(callId)?.resolve({ outcome: 'accepted', agentName: u?.name ?? 'a colleague' });
    this.waiters.delete(callId);
  }

  /**
   * `Routing.onNobody`: the cycle ended without an acceptance. For human-first calls this
   * is where the AI gets dispatched; either way the call goes (back) to `ai`.
   */
  private async nobody(callId: string): Promise<void> {
    const waiter = this.waiters.get(callId);
    this.waiters.delete(callId);
    await addEvent(this.db, callId, 'offer.nobody');
    if (waiter?.fallback) {
      const call = await getCall(this.db, callId);
      if (call) await this.livekit.dispatchAgent(call.roomName, JSON.stringify(waiter.fallback));
    }
    await this.status(callId, 'ai');
    waiter?.resolve({ outcome: 'nobody' });
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
