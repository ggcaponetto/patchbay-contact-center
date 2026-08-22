import type { AgentStatus, ServerMessage } from '@cc/shared';

export type Presence = {
  userId: string;
  tenantId: string;
  name: string;
  status: AgentStatus;
  callId: string | null;
  /** Queue keys the agent is a member of. */
  queues: string[];
};

type Offer = {
  callId: string;
  tenantId: string;
  queueKey: string;
  reason: string | undefined;
  summary: string | undefined;
  tried: Set<string>;
  current: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Deadline for the whole ring cycle (human-first fallback); null = ring until exhausted. */
  giveUpAt: number | null;
  ringMs: number;
};

export type RoutingEvents = {
  send(userId: string, message: ServerMessage): void;
  /** Nobody accepted (all declined, timed out, or none online): caller decides the fallback. */
  onNobody(callId: string, tenantId: string): void;
  onAccepted(callId: string, userId: string): void;
  presenceChanged(tenantId: string): void;
};

/**
 * In-memory routing: who is online, and which call is ringing whom.
 * One process, one instance; restarts lose presence (agents reconnect) — fine for the POC.
 */
export class Routing {
  private readonly agents = new Map<string, Presence>();
  private readonly offers = new Map<string, Offer>();
  private readonly offerTimeoutMs: number;
  private readonly events: RoutingEvents;
  private readonly now: () => number;

  constructor(events: RoutingEvents, offerTimeoutSec = 20, now: () => number = Date.now) {
    this.events = events;
    this.offerTimeoutMs = offerTimeoutSec * 1000;
    this.now = now;
  }

  /** Called when a desk connects or changes status. */
  setPresence(p: Omit<Presence, 'callId'> & { callId?: string | null }): void {
    const prev = this.agents.get(p.userId);
    this.agents.set(p.userId, { callId: prev?.callId ?? null, ...p });
    this.events.presenceChanged(p.tenantId);
  }

  /** Called when a desk disconnects. Any ringing offer moves to the next agent. */
  removePresence(userId: string): void {
    const p = this.agents.get(userId);
    if (!p) return;
    this.agents.delete(userId);
    for (const offer of this.offers.values()) {
      if (offer.current === userId) this.advance(offer);
    }
    this.events.presenceChanged(p.tenantId);
  }

  snapshot(tenantId: string): Presence[] {
    return [...this.agents.values()].filter((a) => a.tenantId === tenantId);
  }

  /** Starts ringing available agents of the queue, one at a time. */
  offer(input: {
    callId: string;
    tenantId: string;
    queueKey: string;
    reason?: string;
    summary?: string;
    giveUpAfterSec?: number;
    /** Seconds each agent rings before the next one is tried. */
    ringSec?: number;
  }): void {
    if (this.offers.has(input.callId)) return;
    const offer: Offer = {
      callId: input.callId,
      tenantId: input.tenantId,
      queueKey: input.queueKey,
      reason: input.reason,
      summary: input.summary,
      tried: new Set(),
      current: null,
      timer: null,
      giveUpAt: input.giveUpAfterSec ? this.now() + input.giveUpAfterSec * 1000 : null,
      ringMs: input.ringSec ? input.ringSec * 1000 : this.offerTimeoutMs,
    };
    this.offers.set(input.callId, offer);
    this.advance(offer);
  }

  /** The ringing agent accepted. Returns false when the offer is no longer theirs. */
  accept(callId: string, userId: string): boolean {
    const offer = this.offers.get(callId);
    if (!offer || offer.current !== userId) return false;
    this.clear(offer);
    this.offers.delete(callId);
    const agent = this.agents.get(userId);
    if (agent) {
      agent.status = 'busy';
      agent.callId = callId;
      this.events.presenceChanged(agent.tenantId);
    }
    this.events.onAccepted(callId, userId);
    return true;
  }

  decline(callId: string, userId: string): void {
    const offer = this.offers.get(callId);
    if (offer && offer.current === userId) this.advance(offer);
  }

  /** The call ended or was otherwise resolved; stop ringing and free the agent. */
  release(callId: string): void {
    const offer = this.offers.get(callId);
    if (offer) {
      this.clear(offer);
      this.offers.delete(callId);
      if (offer.current) this.events.send(offer.current, { type: 'call.offer.cancelled', callId });
    }
    for (const agent of this.agents.values()) {
      if (agent.callId === callId) {
        agent.callId = null;
        agent.status = 'available';
        this.events.presenceChanged(agent.tenantId);
      }
    }
  }

  ringing(callId: string): string | null {
    return this.offers.get(callId)?.current ?? null;
  }

  private candidate(offer: Offer): Presence | undefined {
    return [...this.agents.values()].find(
      (a) =>
        a.tenantId === offer.tenantId &&
        a.status === 'available' &&
        a.callId === null &&
        a.queues.includes(offer.queueKey) &&
        !offer.tried.has(a.userId) &&
        !this.isRingingSomeone(a.userId),
    );
  }

  private isRingingSomeone(userId: string): boolean {
    for (const o of this.offers.values()) if (o.current === userId) return true;
    return false;
  }

  private advance(offer: Offer): void {
    this.clear(offer);
    if (offer.current) {
      this.events.send(offer.current, { type: 'call.offer.cancelled', callId: offer.callId });
      offer.tried.add(offer.current);
      offer.current = null;
    }
    if (offer.giveUpAt !== null && this.now() >= offer.giveUpAt) return this.nobody(offer);
    const next = this.candidate(offer);
    // Every eligible agent was tried (or nobody is online): give up, the caller falls back.
    if (!next) return this.nobody(offer);
    offer.current = next.userId;
    const ringFor = Math.min(
      offer.ringMs,
      offer.giveUpAt === null ? offer.ringMs : offer.giveUpAt - this.now(),
    );
    this.events.send(next.userId, {
      type: 'call.offer',
      callId: offer.callId,
      queueKey: offer.queueKey,
      ...(offer.reason !== undefined ? { reason: offer.reason } : {}),
      ...(offer.summary !== undefined ? { summary: offer.summary } : {}),
      expiresAt: new Date(this.now() + ringFor).toISOString(),
    });
    offer.timer = setTimeout(() => this.advance(offer), ringFor);
  }

  private nobody(offer: Offer): void {
    this.clear(offer);
    this.offers.delete(offer.callId);
    this.events.onNobody(offer.callId, offer.tenantId);
  }

  private clear(offer: Offer): void {
    if (offer.timer) clearTimeout(offer.timer);
    offer.timer = null;
  }
}
