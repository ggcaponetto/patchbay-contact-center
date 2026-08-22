/**
 * In-memory presence and ring-offer state machine. No database, no LiveKit, no I/O:
 * the class only keeps maps and timers and reports back through {@link RoutingEvents},
 * which is what makes it unit-testable with fake timers (`routing.test.ts`).
 *
 * Two pieces of state:
 *
 * - **presence** (`agents`): one {@link Presence} per connected desk user, maintained by
 *   `ws.ts` (`setPresence` on connect / status change, `removePresence` on disconnect).
 * - **offers** (`offers`): one per call that is currently ringing. An offer rings one
 *   agent at a time (`current`), remembers who was already tried, and `advance`s on
 *   decline, timeout or disconnect until someone accepts or nobody is left.
 *
 * `Flow` owns the single instance and implements the callbacks.
 *
 * @see apps/api/src/README.md
 * @packageDocumentation
 */
import type { AgentStatus, ServerMessage } from '@cc/shared';

/** A desk user as seen by the router: who, where, and whether they can take a call. */
export type Presence = {
  userId: string;
  tenantId: string;
  /** Display name, sent to colleagues in the `presence` websocket message. */
  name: string;
  /** `available` agents are ring candidates; `busy` / `away` are skipped. */
  status: AgentStatus;
  /** Call the agent accepted and is still on, or `null`. Set by `accept`, cleared by `release`. */
  callId: string | null;
};

/** Ring cycle for one call. Private to the router; exposed to tests only through behavior. */
type Offer = {
  callId: string;
  tenantId: string;
  queueKey: string;
  reason: string | undefined;
  summary: string | undefined;
  /** Agents already rung for this call (declined, timed out, or disconnected). */
  tried: Set<string>;
  /** Agent currently ringing, or `null` between steps. */
  current: string | null;
  /** Timeout that moves to the next agent when `current` does not answer. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Deadline for the whole ring cycle (human-first fallback); null = ring until exhausted. */
  giveUpAt: number | null;
  /** How long each agent rings before the next one is tried. */
  ringMs: number;
  /** User ids that may take this call (members of the queue at offer time). */
  members: Set<string>;
};

/** Callbacks through which the router talks to the rest of the system. */
export type RoutingEvents = {
  /** Deliver a websocket message to one user (all their open desks). */
  send(userId: string, message: ServerMessage): void;
  /** Nobody accepted (all declined, timed out, or none online): caller decides the fallback. */
  onNobody(callId: string, tenantId: string): void;
  /** The ringing agent accepted; the caller mints the join token. */
  onAccepted(callId: string, userId: string): void;
  /** Presence of the tenant changed; the caller broadcasts a fresh snapshot. */
  presenceChanged(tenantId: string): void;
};

/**
 * In-memory routing: who is online, and which call is ringing whom.
 * One process, one instance; restarts lose presence (agents reconnect) — fine for the POC.
 *
 * Candidate rule (see `candidate`): same tenant, status `available`, not on a call, member
 * of the offer's queue, not already tried for this offer, and not currently ringing for
 * another call. The first match in insertion order wins; there is no load balancing.
 *
 * @example
 * ```ts
 * const routing = new Routing(events, 20);
 * routing.setPresence({ userId: 'u1', tenantId: 't', name: 'Ann', status: 'available', queues: ['support'] });
 * routing.offer({ callId: 'c1', tenantId: 't', queueKey: 'support' }); // events.send('u1', call.offer)
 * routing.accept('c1', 'u1'); // true; events.onAccepted('c1', 'u1')
 * ```
 */
export class Routing {
  private readonly agents = new Map<string, Presence>();
  private readonly offers = new Map<string, Offer>();
  private readonly offerTimeoutMs: number;
  private readonly events: RoutingEvents;
  private readonly now: () => number;

  /**
   * @param events - Callbacks, see {@link RoutingEvents}.
   * @param offerTimeoutSec - Default ring time per agent when `offer()` gets no `ringSec`.
   * @param now - Clock, injectable for tests (defaults to `Date.now`).
   */
  constructor(events: RoutingEvents, offerTimeoutSec = 20, now: () => number = Date.now) {
    this.events = events;
    this.offerTimeoutMs = offerTimeoutSec * 1000;
    this.now = now;
  }

  /**
   * Called when a desk connects or changes status. Keeps the agent's current `callId`
   * (a status change while on a call must not free the agent).
   */
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

  /** Everyone currently online in the tenant (what the `presence` message carries). */
  snapshot(tenantId: string): Presence[] {
    return [...this.agents.values()].filter((a) => a.tenantId === tenantId);
  }

  /**
   * Starts ringing available agents of the queue, one at a time.
   * Idempotent per call: a second `offer` for a ringing call is ignored.
   *
   * With `giveUpAfterSec` (human-first mode) the cycle stops at the deadline even if
   * untried agents remain; without it, it stops when every candidate was tried.
   */
  offer(input: {
    callId: string;
    tenantId: string;
    queueKey: string;
    /** Shown to the agent in the offer (AI escalation reason). */
    reason?: string;
    /** Shown to the agent in the offer (AI conversation summary). */
    summary?: string;
    /** Stop the whole cycle after this many seconds and report `onNobody`. */
    giveUpAfterSec?: number;
    /** Seconds each agent rings before the next one is tried. */
    ringSec?: number;
    /** Members of the queue; only these agents are rung. */
    members: string[];
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
      members: new Set(input.members),
    };
    this.offers.set(input.callId, offer);
    this.advance(offer);
  }

  /**
   * The ringing agent accepted. Returns false when the offer is no longer theirs
   * (it moved on, was cancelled, or never existed), so the route can answer 409.
   * On success the agent becomes `busy` on that call and `onAccepted` fires.
   */
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

  /** The ringing agent declined: move on. Ignored unless the offer is currently theirs. */
  decline(callId: string, userId: string): void {
    const offer = this.offers.get(callId);
    if (offer && offer.current === userId) this.advance(offer);
  }

  /**
   * The call ended or was otherwise resolved; stop ringing and free the agent.
   * Safe to call for calls that are not ringing and have no agent (no-op).
   */
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

  /** Who the call is ringing right now, or `null`. */
  ringing(callId: string): string | null {
    return this.offers.get(callId)?.current ?? null;
  }

  private candidate(offer: Offer): Presence | undefined {
    return [...this.agents.values()].find(
      (a) =>
        a.tenantId === offer.tenantId &&
        a.status === 'available' &&
        a.callId === null &&
        offer.members.has(a.userId) &&
        !offer.tried.has(a.userId) &&
        !this.isRingingSomeone(a.userId),
    );
  }

  private isRingingSomeone(userId: string): boolean {
    for (const o of this.offers.values()) if (o.current === userId) return true;
    return false;
  }

  /**
   * One step of the ring cycle: cancel the current agent (if any), then either give up
   * or ring the next candidate and arm the timer that calls `advance` again.
   */
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
    // Never ring past the overall deadline: the last agent may get a shorter ring.
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
