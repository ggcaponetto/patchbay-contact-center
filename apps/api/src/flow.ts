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

export type Outcome = { outcome: 'accepted'; agentName: string } | { outcome: 'nobody' };

type Waiter = { resolve: (o: Outcome) => void; fallback?: DispatchMetadata };

/**
 * Ties routing to persistence and LiveKit: escalations, human-first ringing,
 * accept / take-over tokens. One instance per API process.
 */
export class Flow {
  readonly routing: Routing;
  private readonly waiters = new Map<string, Waiter>();
  private readonly db: Db;
  private readonly livekit: LiveKit;
  private readonly hub: EventEmitter;

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

  /** The AI asked for a human. Resolves when someone accepted or nobody could. */
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

  /** Human-first: ring the queue; if nobody picks up in time, dispatch the AI with `fallback`. */
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

  /** Mints a token for the accepting agent (or a supervisor taking over / listening). */
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

  /** A desk participant left the call. The human agent leaving ends the call. */
  async leave(callId: string, u: { id: string }, role: 'human' | 'supervisor'): Promise<void> {
    await markParticipantLeft(this.db, callId, `${role}:${u.id}`);
    await addEvent(this.db, callId, `${role}.left`, { userId: u.id });
    this.routing.release(callId);
    if (role === 'human') await this.end(callId);
  }

  /** Marks the call ended and tears the room down (idempotent). */
  async end(callId: string): Promise<void> {
    const call = await getCall(this.db, callId);
    if (!call || call.status === 'ended') return;
    await this.livekit.deleteRoom(call.roomName);
    await this.status(callId, 'ended');
    this.routing.release(callId);
    this.waiters.get(callId)?.resolve({ outcome: 'nobody' });
    this.waiters.delete(callId);
  }

  private async accepted(callId: string, userId: string): Promise<void> {
    const [u] = await this.db.select().from(user).where(eq(user.id, userId));
    await addEvent(this.db, callId, 'offer.accepted', { userId });
    this.waiters.get(callId)?.resolve({ outcome: 'accepted', agentName: u?.name ?? 'a colleague' });
    this.waiters.delete(callId);
  }

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

  private async status(
    callId: string,
    status: 'waiting_human' | 'human' | 'ai' | 'ended',
  ): Promise<void> {
    const row = await setCallStatus(this.db, callId, status);
    if (row) this.hub.emit('call.updated', { tenantId: row.tenantId, callId, status });
  }
}
