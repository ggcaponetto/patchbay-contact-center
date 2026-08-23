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
  callDetail,
  getCall,
  markParticipantLeft,
  setCallStatus,
  setHeld,
  setRecording,
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
  /** Token minting and room control; desk routes use it for the media worker's token. */
  readonly livekit: LiveKit;
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
   * Mints a token for the accepting agent, or for a supervisor in one of the
   * monitoring / intervention modes:
   *
   * - `agent`: the human who accepted the offer; call becomes `human`.
   * - `takeover`: a supervisor joins as a full participant; call becomes `human`.
   * - `intercept`: take-over plus the current agent is removed from the room and freed.
   * - `listen`: silent monitoring, subscribe-only (`canPublish: false`); status unchanged.
   * - `whisper`: the supervisor talks, but only desks play their audio — the embed
   *   skips tracks flagged `monitor: 'whisper'`, so the customer never hears them.
   * - `barge`: the supervisor talks and everyone hears them; status unchanged.
   *
   * Also records the participant row and a `<mode>.joined` event (the desk shows the
   * monitoring chip off the live supervisor participant when `monitorNotify` is on).
   * Does **not** check that the user was actually rung: desk routes do that through
   * `routing.accept`.
   *
   * @returns `{ token, url }` for the LiveKit client, or `undefined` if the call is
   *   unknown or already ended (routes answer 409 `call_over`).
   */
  async join(
    callId: string,
    u: { id: string; name: string },
    mode: 'agent' | 'takeover' | 'intercept' | 'listen' | 'whisper' | 'barge',
  ): Promise<{ token: string; url: string } | undefined> {
    const call = await getCall(this.db, callId);
    if (!call || call.status === 'ended') return undefined;
    const handling = mode === 'agent' || mode === 'takeover' || mode === 'intercept';
    const role = handling ? 'human' : 'supervisor';
    const identity = `${role}:${u.id}`;
    const token = await this.livekit.createToken({
      room: call.roomName,
      identity,
      name: u.name,
      attributes: {
        role,
        userId: u.id,
        displayName: u.name,
        ...(mode === 'whisper' ? { monitor: 'whisper' as const } : {}),
      },
      canPublish: mode !== 'listen',
    });
    // Intercept: the handling agent is thrown out of the room and freed before the
    // supervisor's participant row lands, so the desk never shows both as active.
    if (mode === 'intercept') {
      const detail = await callDetail(this.db, call.tenantId, callId);
      const current = (detail?.participants ?? []).find(
        (p) => p.kind === 'human' && p.leftAt === null && p.userId !== u.id,
      );
      if (current) {
        await this.livekit.removeParticipant(call.roomName, current.identity);
        await markParticipantLeft(this.db, callId, current.identity);
        await addEvent(this.db, callId, 'intercept', { userId: u.id, dropped: current.userId });
        if (current.userId) await this.freeUser(callId, current.userId);
      }
    }
    await addParticipant(this.db, { callId, kind: role, identity, userId: u.id });
    await addEvent(this.db, callId, `${mode}.joined`, { userId: u.id, name: u.name });
    // `accept` already marked the agent busy; a take-over marks the supervisor.
    if (handling && mode !== 'agent') await this.routing.busy(callId, u.id);
    if (handling) await this.status(callId, 'human');
    else this.hub.emit('call.updated', { tenantId: call.tenantId, callId, status: call.status });
    return { token, url: this.livekit.url };
  }

  /**
   * A desk participant left the call. The **last** human leaving ends the call; while
   * other humans remain (a consultation), only the leaver is freed into wrap-up. A
   * monitoring supervisor (listen / whisper / barge) leaving changes nothing for the
   * call: nobody was marked busy for them, so nothing is freed and the call goes on.
   *
   * @param role - Which identity left: `human:<id>` or `supervisor:<id>`.
   */
  async leave(callId: string, u: { id: string }, role: 'human' | 'supervisor'): Promise<void> {
    await markParticipantLeft(this.db, callId, `${role}:${u.id}`);
    await addEvent(this.db, callId, `${role}.left`, { userId: u.id });
    if (role === 'supervisor') {
      const call = await getCall(this.db, callId);
      if (call) {
        this.hub.emit('call.updated', { tenantId: call.tenantId, callId, status: call.status });
      }
      return;
    }
    if ((await this.humansOn(callId, u.id)) > 0) {
      await this.freeUser(callId, u.id);
      return;
    }
    await this.release(callId);
    await this.end(callId);
  }

  /** Active (not left) human participants on the call, excluding `exceptUserId`. */
  private async humansOn(callId: string, exceptUserId?: string): Promise<number> {
    const call = await getCall(this.db, callId);
    const detail = call ? await callDetail(this.db, call.tenantId, callId) : undefined;
    return (detail?.participants ?? []).filter(
      (p) => p.kind === 'human' && p.leftAt === null && p.userId !== exceptUserId,
    ).length;
  }

  /** Frees one user (wrap-up per tenant settings) without releasing the whole call. */
  private async freeUser(callId: string, userId: string): Promise<void> {
    const call = await getCall(this.db, callId);
    const tenant = call ? await getTenant(this.db, call.tenantId) : undefined;
    await this.routing.free(userId, { acwSec: tenant?.settings.acwSec ?? 0 });
  }

  /** Takes the customer off hold: state, event, and the media worker's stop command. */
  async unhold(callId: string): Promise<void> {
    const call = await getCall(this.db, callId);
    if (!call || !call.heldAt) return;
    await setHeld(this.db, callId, false);
    await addEvent(this.db, callId, 'retrieve', {});
    await this.bus.publish({ kind: 'media', command: { action: 'moh.stop', callId } });
    this.hub.emit('call.updated', { tenantId: call.tenantId, callId, status: call.status });
  }

  /** Puts the customer on hold: state, event, and the media worker's start command. */
  async hold(callId: string): Promise<void> {
    const call = await getCall(this.db, callId);
    if (!call || call.heldAt || call.status === 'ended') return;
    await setHeld(this.db, callId, true);
    await addEvent(this.db, callId, 'hold', {});
    const token = await this.livekit.createToken({
      room: call.roomName,
      identity: `media:${callId}`,
      name: 'Music',
      attributes: { role: 'media' },
    });
    await this.bus.publish({
      kind: 'media',
      command: {
        action: 'moh.start',
        callId,
        roomName: call.roomName,
        token,
        url: this.livekit.url,
      },
    });
    this.hub.emit('call.updated', { tenantId: call.tenantId, callId, status: call.status });
  }

  /**
   * Blind (cold) transfer: the transferring agent is marked gone and freed, the customer
   * goes on hold with music, and the target — a queue's members or a single user — is
   * rung; whoever accepts also takes the customer off hold (`retrieveOnAccept`).
   */
  async transfer(
    callId: string,
    from: { id: string; name: string },
    target: { kind: 'queue'; id: string } | { kind: 'user'; id: string },
  ): Promise<'not_live' | 'empty_target' | null> {
    const call = await getCall(this.db, callId);
    if (!call || call.status === 'ended') return 'not_live';
    const members = target.kind === 'queue' ? await this.queueMembers(target.id) : [target.id];
    if (members.length === 0) return 'empty_target';
    const tenant = await getTenant(this.db, call.tenantId);
    const [q] = await this.db.select().from(queue).where(eq(queue.id, call.queueId));
    await markParticipantLeft(this.db, callId, `human:${from.id}`);
    await addEvent(this.db, callId, 'transfer', { userId: from.id, target });
    await this.routing.free(from.id, { acwSec: tenant?.settings.acwSec ?? 0 });
    await this.hold(callId);
    await this.status(callId, 'waiting_human');
    await this.routing.offer({
      callId,
      tenantId: call.tenantId,
      queueKey: q?.key ?? '',
      reason: `Transfer from ${from.name}`,
      ...(tenant ? { ringSec: tenant.settings.offerTimeoutSec } : {}),
      members,
      retrieveOnAccept: true,
    });
    return null;
  }

  /**
   * Consultation: the customer goes on hold with music and `targetUserId` is rung into
   * the same room (their accept joins them as another human). The customer keeps
   * hearing music until the consult is completed or the customer is retrieved (swap).
   */
  async consult(
    callId: string,
    from: { id: string; name: string },
    targetUserId: string,
  ): Promise<'not_live' | null> {
    const call = await getCall(this.db, callId);
    if (!call || call.status === 'ended') return 'not_live';
    const tenant = await getTenant(this.db, call.tenantId);
    const [q] = await this.db.select().from(queue).where(eq(queue.id, call.queueId));
    await addEvent(this.db, callId, 'consult', { userId: from.id, targetUserId });
    await this.hold(callId);
    await this.routing.offer({
      callId,
      tenantId: call.tenantId,
      queueKey: q?.key ?? '',
      reason: `Consultation with ${from.name}`,
      ...(tenant ? { ringSec: tenant.settings.offerTimeoutSec } : {}),
      members: [targetUserId],
    });
    return null;
  }

  /**
   * Ends a consultation. `transfer`: the initiator leaves and the consultant keeps the
   * (retrieved) customer. `conference`: everyone stays, customer retrieved. `drop`: the
   * consultant is removed from the room and freed; the initiator retrieves by hand.
   */
  async consultComplete(
    callId: string,
    from: { id: string },
    mode: 'transfer' | 'conference' | 'drop',
    dropUserId?: string,
  ): Promise<'not_live' | 'no_consultant' | null> {
    const call = await getCall(this.db, callId);
    if (!call || call.status === 'ended') return 'not_live';
    if (mode === 'drop') {
      const detail = await callDetail(this.db, call.tenantId, callId);
      const consultant = (detail?.participants ?? []).find(
        (p) =>
          p.kind === 'human' &&
          p.leftAt === null &&
          (dropUserId ? p.userId === dropUserId : p.userId !== from.id),
      );
      if (!consultant) return 'no_consultant';
      await this.livekit.removeParticipant(call.roomName, consultant.identity);
      await markParticipantLeft(this.db, callId, consultant.identity);
      await addEvent(this.db, callId, 'consult.dropped', { userId: consultant.userId });
      if (consultant.userId) await this.freeUser(callId, consultant.userId);
      this.hub.emit('call.updated', { tenantId: call.tenantId, callId, status: call.status });
      return null;
    }
    await this.unhold(callId);
    await addEvent(this.db, callId, mode === 'transfer' ? 'transfer.completed' : 'conference', {
      userId: from.id,
    });
    if (mode === 'transfer') {
      await markParticipantLeft(this.db, callId, `human:${from.id}`);
      await this.freeUser(callId, from.id);
      this.hub.emit('call.updated', { tenantId: call.tenantId, callId, status: call.status });
    }
    return null;
  }

  /**
   * Drives the call-recording state machine: `off` → `on` (start) ⇄ `paused`
   * (pause / resume) → `off` (stop). Every `start` / `resume` begins a fresh Egress
   * segment and every `pause` / `stop` ends one, so a PCI pause is simply a gap between
   * stored files. Each step is journaled as a `recording.<action>` event.
   */
  async recording(
    callId: string,
    action: 'start' | 'pause' | 'resume' | 'stop',
    by: { id: string },
  ): Promise<'not_live' | 'invalid_state' | 'recording_unavailable' | null> {
    const call = await getCall(this.db, callId);
    if (!call || call.status === 'ended') return 'not_live';
    const allowed: Record<typeof action, string[]> = {
      start: ['off'],
      pause: ['on'],
      resume: ['paused'],
      stop: ['on', 'paused'],
    };
    if (!allowed[action].includes(call.recordingState)) return 'invalid_state';
    let egressId: string | null = null;
    if (action === 'start' || action === 'resume') {
      egressId = await this.livekit.startRecording(call.roomName);
      if (egressId === null) return 'recording_unavailable';
    }
    if (call.recordingEgressId) await this.livekit.stopRecording(call.recordingEgressId);
    const state = action === 'pause' ? 'paused' : egressId === null ? 'off' : 'on';
    await setRecording(this.db, callId, state, egressId);
    await addEvent(this.db, callId, `recording.${action}`, {
      userId: by.id,
      ...(egressId === null ? {} : { egressId }),
    });
    this.hub.emit('call.updated', { tenantId: call.tenantId, callId, status: call.status });
    return null;
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
    // A still-running recording segment ends with the call.
    if (call.recordingEgressId) {
      await this.livekit.stopRecording(call.recordingEgressId);
      await setRecording(this.db, callId, 'off', null);
      await addEvent(this.db, callId, 'recording.stop', { auto: true });
    }
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
