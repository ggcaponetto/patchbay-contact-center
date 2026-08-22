/**
 * In-memory presence and ring-offer state machine. No database, no LiveKit, no I/O:
 * the class only keeps maps and timers and reports back through {@link RoutingEvents},
 * which is what makes it unit-testable with fake timers (`routing.test.ts`).
 *
 * Two pieces of state:
 *
 * - **presence** (`agents`): one {@link Presence} per connected desk user with the
 *   classic agent states (`ready`, `not_ready` + reason, `busy`, `acw`), maintained by
 *   `ws.ts` (`connect` / `removePresence`) and the desk routes (`setState`, wrap-up).
 * - **offers** (`offers`): one per call that is currently ringing. An offer rings one
 *   agent at a time (`current`), remembers who was already tried, and `advance`s on
 *   decline, timeout or disconnect until someone accepts or nobody is left. An agent who
 *   lets the ring time out goes `not_ready` with reason `RONA` (redirect on no answer).
 *
 * After a call the agent enters `acw` (after-call work) for the tenant's `acwSec`, then
 * becomes `ready` automatically; they can extend or finish wrap-up early.
 *
 * `Flow` owns the single instance and implements the callbacks.
 *
 * @see apps/api/src/README.md
 * @packageDocumentation
 */
import { type AgentPresence, type AgentState, RONA_REASON, type ServerMessage } from '@cc/shared';

/** A desk user as seen by the router: who, where, and whether they can take a call. */
export type Presence = {
  userId: string;
  tenantId: string;
  /** Display name, sent to colleagues in the `presence` websocket message. */
  name: string;
  /** Only `ready` agents are ring candidates. */
  state: AgentState;
  /** Reason (aux) code while `not_ready`, else `null`. */
  reason: string | null;
  /** Epoch ms the current state was entered. */
  since: number;
  /** Call the agent is on (`busy`) or wrapping up (`acw`), or `null`. */
  callId: string | null;
  /** Epoch ms the wrap-up ends, while `acw`. */
  acwUntil: number | null;
  /** Wrap-up timer, while `acw`. */
  acwTimer: ReturnType<typeof setTimeout> | null;
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

/** Why {@link Routing.setState} refused. */
export type StateError = 'offline' | 'on_call';

/**
 * In-memory routing: who is online and in which state, and which call is ringing whom.
 * One process, one instance; restarts lose presence (agents reconnect) — fine for the POC.
 *
 * Candidate rule (see `candidate`): same tenant, state `ready`, member of the offer's
 * queue, not already tried for this offer, and not currently ringing for another call.
 * The first match in insertion order wins; there is no load balancing.
 *
 * @example
 * ```ts
 * const routing = new Routing(events, 20);
 * routing.connect({ userId: 'u1', tenantId: 't', name: 'Ann' });
 * routing.setState('u1', 'ready');
 * routing.offer({ callId: 'c1', tenantId: 't', queueKey: 'support', members: ['u1'] });
 * routing.accept('c1', 'u1'); // true; events.onAccepted('c1', 'u1'); u1 is busy
 * routing.release('c1', { acwSec: 30 }); // u1 is in wrap-up, ready again after 30 s
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
   * A desk connected. A new presence starts `not_ready` (reason `null`); a user who is
   * already online (second tab) keeps their state.
   */
  connect(p: { userId: string; tenantId: string; name: string }): void {
    if (!this.agents.has(p.userId)) {
      this.agents.set(p.userId, {
        ...p,
        state: 'not_ready',
        reason: null,
        since: this.now(),
        callId: null,
        acwUntil: null,
        acwTimer: null,
      });
    }
    this.events.presenceChanged(p.tenantId);
  }

  /**
   * The agent (or a supervisor on their behalf) asks for `ready` / `not_ready`. Allowed
   * from any state except `busy` (a state change must not free an agent on a call);
   * leaving `acw` this way ends the wrap-up.
   */
  setState(userId: string, state: 'ready' | 'not_ready', reason?: string): StateError | null {
    const a = this.agents.get(userId);
    if (!a) return 'offline';
    if (a.state === 'busy') return 'on_call';
    this.clearAcw(a);
    this.enter(a, state, state === 'not_ready' ? (reason ?? null) : null);
    return null;
  }

  /** Adds `acwSec` to the running wrap-up; `false` when the agent is not in `acw`. */
  extendAcw(userId: string, acwSec: number): boolean {
    const a = this.agents.get(userId);
    if (!a || a.state !== 'acw') return false;
    const until = (a.acwUntil ?? this.now()) + acwSec * 1000;
    this.clearAcw(a);
    this.startAcw(a, until);
    this.events.presenceChanged(a.tenantId);
    return true;
  }

  /** Called when a desk disconnects. Any ringing offer moves to the next agent. */
  removePresence(userId: string): void {
    const p = this.agents.get(userId);
    if (!p) return;
    this.clearAcw(p);
    this.agents.delete(userId);
    for (const offer of this.offers.values()) {
      if (offer.current === userId) this.advance(offer);
    }
    this.events.presenceChanged(p.tenantId);
  }

  /** Everyone currently online in the tenant (what the `presence` message carries). */
  snapshot(tenantId: string): AgentPresence[] {
    return [...this.agents.values()]
      .filter((a) => a.tenantId === tenantId)
      .map((a) => ({
        userId: a.userId,
        name: a.name,
        state: a.state,
        reason: a.reason,
        since: new Date(a.since).toISOString(),
        callId: a.callId,
        acwUntil: a.acwUntil === null ? null : new Date(a.acwUntil).toISOString(),
      }));
  }

  /** The raw presence of one user, or `undefined` when offline. */
  presenceOf(userId: string): Presence | undefined {
    return this.agents.get(userId);
  }

  /**
   * Starts ringing ready agents of the queue, one at a time.
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
    this.busy(callId, userId);
    this.events.onAccepted(callId, userId);
    return true;
  }

  /** Marks an online user `busy` on a call (accept, take-over). Offline users are ignored. */
  busy(callId: string, userId: string): void {
    const agent = this.agents.get(userId);
    if (!agent) return;
    this.clearAcw(agent);
    agent.callId = callId;
    this.enter(agent, 'busy', null);
  }

  /** The ringing agent declined: move on. Ignored unless the offer is currently theirs. */
  decline(callId: string, userId: string): void {
    const offer = this.offers.get(callId);
    if (offer && offer.current === userId) this.advance(offer);
  }

  /**
   * The call ended or was otherwise resolved; stop ringing and free the agent, who goes
   * into wrap-up for `acwSec` seconds (`ready` right away when `0`).
   * Safe to call for calls that are not ringing and have no agent (no-op).
   */
  release(callId: string, opts: { acwSec: number } = { acwSec: 0 }): void {
    const offer = this.offers.get(callId);
    if (offer) {
      this.clear(offer);
      this.offers.delete(callId);
      if (offer.current) this.events.send(offer.current, { type: 'call.offer.cancelled', callId });
    }
    for (const agent of this.agents.values()) {
      if (agent.callId !== callId) continue;
      if (opts.acwSec > 0) {
        agent.state = 'acw';
        agent.reason = null;
        agent.since = this.now();
        this.startAcw(agent, this.now() + opts.acwSec * 1000);
        this.events.presenceChanged(agent.tenantId);
      } else {
        agent.callId = null;
        this.enter(agent, 'ready', null);
      }
    }
  }

  /** Who the call is ringing right now, or `null`. */
  ringing(callId: string): string | null {
    return this.offers.get(callId)?.current ?? null;
  }

  private enter(a: Presence, state: AgentState, reason: string | null): void {
    a.state = state;
    a.reason = reason;
    a.since = this.now();
    if (state !== 'busy' && state !== 'acw') a.callId = null;
    this.events.presenceChanged(a.tenantId);
  }

  private startAcw(a: Presence, until: number): void {
    a.acwUntil = until;
    a.acwTimer = setTimeout(
      () => {
        a.acwTimer = null;
        a.acwUntil = null;
        this.enter(a, 'ready', null);
      },
      Math.max(0, until - this.now()),
    );
  }

  private clearAcw(a: Presence): void {
    if (a.acwTimer) clearTimeout(a.acwTimer);
    a.acwTimer = null;
    a.acwUntil = null;
  }

  private candidate(offer: Offer): Presence | undefined {
    return [...this.agents.values()].find(
      (a) =>
        a.tenantId === offer.tenantId &&
        a.state === 'ready' &&
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
   * or ring the next candidate and arm the timer that calls `advance` again. A ring that
   * timed out (`rona`) also parks the agent: `not_ready` with reason `RONA`.
   */
  private advance(offer: Offer, rona = false): void {
    this.clear(offer);
    if (offer.current) {
      this.events.send(offer.current, { type: 'call.offer.cancelled', callId: offer.callId });
      offer.tried.add(offer.current);
      const missed = this.agents.get(offer.current);
      if (rona && missed && missed.state === 'ready') this.enter(missed, 'not_ready', RONA_REASON);
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
    offer.timer = setTimeout(() => this.advance(offer, true), ringFor);
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
