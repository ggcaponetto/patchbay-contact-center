/**
 * Routing engine over Postgres: who is online and in which agent state
 * (`agent_presence`), and which call is ringing whom (`ring_offer`). Nothing lives in
 * process memory, so an API restart loses no presence or ringing call, and several API
 * instances share one engine: each runs the same {@link Routing.tick} and the row locks
 * (`FOR UPDATE SKIP LOCKED`) decide who advances an offer.
 *
 * Two pieces of state:
 *
 * - **presence**: one row per connected desk user with the classic agent states
 *   (`ready`, `not_ready` + reason, `busy`, `acw`), the time it was entered, and the
 *   instance whose sockets the user is on (`lastSeen` heartbeat; users of a dead
 *   instance are swept by the tick). Maintained by `ws.ts` (`connect` / `disconnect`)
 *   and the desk routes (`setState`, wrap-up).
 * - **offers**: one row per call that is currently ringing. An offer rings one agent at
 *   a time (`currentUserId` until `ringUntil`), remembers who was already tried, and
 *   advances on decline, timeout (the tick) or disconnect until someone accepts or
 *   nobody is left. An agent who lets the ring time out goes `not_ready` with reason
 *   `RONA`.
 *
 * After a call the agent enters `acw` (after-call work) for the tenant's `acwSec`; the
 * tick turns that into `ready` when `acwUntil` passes.
 *
 * Everything that must reach a desk goes through the {@link Bus} (`send`, `presence`),
 * because the desk may be on another instance. `Flow` owns the single instance per
 * process and implements the callbacks.
 *
 * @see apps/api/src/README.md
 * @packageDocumentation
 */
import { type AgentPresence, type AgentState, RONA_REASON, type ServerMessage } from '@cc/shared';
import { and, eq, lt, lte, sql } from 'drizzle-orm';
import type { Bus } from './bus.ts';
import type { Db } from './db/client.ts';
import { agentPresence, ringOffer } from './db/schema.ts';

/** One `agent_presence` row. */
export type Presence = typeof agentPresence.$inferSelect;
type Offer = typeof ringOffer.$inferSelect;

/** Callbacks through which the router talks to the rest of the system. */
export type RoutingEvents = {
  /**
   * Nobody accepted (all declined, timed out, or none online). `fallback` is what
   * `offer()` was given (human-first dispatch metadata), so any instance can act on it.
   */
  onNobody(
    callId: string,
    tenantId: string,
    fallback: Record<string, unknown> | null,
  ): Promise<void>;
  /** The ringing agent accepted; the caller records it and resolves the escalation. */
  onAccepted(callId: string, userId: string): Promise<void>;
};

/** Why {@link Routing.setState} refused. */
export type StateError = 'offline' | 'on_call';

/** Postgres array literal for a bound parameter (drizzle would expand a JS array to a tuple). */
const pgArray = (values: string[]) => `{${values.map((v) => JSON.stringify(v)).join(',')}}`;

/** A presence whose heartbeat is older than this is considered gone (its instance died). */
const STALE_MS = 30_000;

/** Dependencies of {@link Routing}. */
export type RoutingDeps = {
  db: Db;
  bus: Bus;
  /** Identifies this API process in `agent_presence.instance_id`. */
  instanceId: string;
  events: RoutingEvents;
  /** Default ring time per agent when `offer()` gets no `ringSec`. */
  offerTimeoutSec?: number;
  /** Clock, injectable for tests (defaults to `Date.now`). */
  now?: () => number;
};

/**
 * The engine. See the module comment.
 *
 * Candidate rule (see `candidate`): same tenant, state `ready`, member of the offer's
 * queue, not already tried for this offer, and not currently being rung for another
 * call. The earliest-connected match wins; there is no load balancing yet.
 *
 * @example
 * ```ts
 * const routing = new Routing({ db, bus, instanceId: 'api-1', events });
 * await routing.connect({ userId: 'u1', tenantId: 't', name: 'Ann' });
 * await routing.setState('u1', 'ready');
 * await routing.offer({ callId: 'c1', tenantId: 't', queueKey: 'support', members: ['u1'] });
 * await routing.accept('c1', 'u1'); // true; events.onAccepted('c1', 'u1'); u1 is busy
 * await routing.release('c1', { acwSec: 30 }); // u1 wraps up; tick() makes them ready later
 * ```
 */
export class Routing {
  private readonly db: Db;
  private readonly bus: Bus;
  private readonly instanceId: string;
  private readonly events: RoutingEvents;
  private readonly offerTimeoutMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: RoutingDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.instanceId = deps.instanceId;
    this.events = deps.events;
    this.offerTimeoutMs = (deps.offerTimeoutSec ?? 20) * 1000;
    this.now = deps.now ?? Date.now;
  }

  /** Runs {@link Routing.tick} every `intervalMs` until {@link Routing.stop}. */
  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), intervalMs);
  }

  /** Stops the periodic tick. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass of the timers, safe to run on every instance concurrently:
   * heartbeat for this instance's users, sweep of users whose instance died, wrap-ups
   * that expired, rings that timed out (RONA for the agent, next candidate or nobody).
   */
  async tick(): Promise<void> {
    const now = new Date(this.now());
    await this.db
      .update(agentPresence)
      .set({ lastSeen: now })
      .where(eq(agentPresence.instanceId, this.instanceId));
    const stale = await this.db
      .delete(agentPresence)
      .where(lt(agentPresence.lastSeen, new Date(this.now() - STALE_MS)))
      .returning();
    for (const gone of stale) {
      await this.publishPresence(gone.tenantId);
      await this.advanceOffersOf(gone.userId, false);
    }
    const wrapped = await this.db
      .update(agentPresence)
      .set({ state: 'ready', reason: null, since: now, callId: null, acwUntil: null })
      .where(and(eq(agentPresence.state, 'acw'), lte(agentPresence.acwUntil, now)))
      .returning();
    for (const a of wrapped) await this.publishPresence(a.tenantId);
    const expired = await this.db
      .select({ callId: ringOffer.callId })
      .from(ringOffer)
      .where(lte(ringOffer.ringUntil, now));
    for (const { callId } of expired) await this.advance(callId, true);
  }

  /**
   * A desk connected. A new presence starts `not_ready` (reason `null`); a user who is
   * already online (second tab, reconnect after a restart) keeps their state and is
   * re-homed on this instance.
   */
  async connect(p: { userId: string; tenantId: string; name: string }): Promise<void> {
    const now = new Date(this.now());
    await this.db
      .insert(agentPresence)
      .values({
        ...p,
        state: 'not_ready',
        reason: null,
        since: now,
        instanceId: this.instanceId,
        lastSeen: now,
      })
      .onConflictDoUpdate({
        target: agentPresence.userId,
        set: { name: p.name, tenantId: p.tenantId, instanceId: this.instanceId, lastSeen: now },
      });
    await this.publishPresence(p.tenantId);
  }

  /** Called when a desk disconnects (last socket). Any ringing offer moves on. */
  async disconnect(userId: string): Promise<void> {
    const [gone] = await this.db
      .delete(agentPresence)
      .where(eq(agentPresence.userId, userId))
      .returning();
    if (!gone) return;
    await this.publishPresence(gone.tenantId);
    await this.advanceOffersOf(userId, false);
  }

  /**
   * The agent (or a supervisor on their behalf) asks for `ready` / `not_ready`. Allowed
   * from any state except `busy` (a state change must not free an agent on a call);
   * leaving `acw` this way ends the wrap-up.
   */
  async setState(
    userId: string,
    state: 'ready' | 'not_ready',
    reason?: string,
  ): Promise<StateError | null> {
    const a = await this.presenceOf(userId);
    if (!a) return 'offline';
    if (a.state === 'busy') return 'on_call';
    await this.enter(userId, state, state === 'not_ready' ? (reason ?? null) : null);
    await this.publishPresence(a.tenantId);
    return null;
  }

  /** Adds `acwSec` to the running wrap-up; `false` when the agent is not in `acw`. */
  async extendAcw(userId: string, acwSec: number): Promise<boolean> {
    const a = await this.presenceOf(userId);
    if (!a || a.state !== 'acw') return false;
    const until = new Date((a.acwUntil?.getTime() ?? this.now()) + acwSec * 1000);
    await this.db
      .update(agentPresence)
      .set({ acwUntil: until })
      .where(eq(agentPresence.userId, userId));
    await this.publishPresence(a.tenantId);
    return true;
  }

  /** Everyone currently online in the tenant (what the `presence` message carries). */
  async snapshot(tenantId: string): Promise<AgentPresence[]> {
    const rows = await this.db
      .select()
      .from(agentPresence)
      .where(eq(agentPresence.tenantId, tenantId))
      .orderBy(agentPresence.seq);
    return rows.map((a) => ({
      userId: a.userId,
      name: a.name,
      state: a.state,
      reason: a.reason,
      since: a.since.toISOString(),
      callId: a.callId,
      acwUntil: a.acwUntil?.toISOString() ?? null,
    }));
  }

  /** The raw presence row of one user, or `undefined` when offline. */
  async presenceOf(userId: string): Promise<Presence | undefined> {
    const [row] = await this.db
      .select()
      .from(agentPresence)
      .where(eq(agentPresence.userId, userId));
    return row;
  }

  /**
   * Starts ringing ready agents of the queue, one at a time.
   * Idempotent per call: a second `offer` for a ringing call is ignored.
   *
   * With `giveUpAfterSec` (human-first mode) the cycle stops at the deadline even if
   * untried agents remain; without it, it stops when every candidate was tried.
   */
  async offer(input: {
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
    /** Handed back to `onNobody` unchanged (human-first dispatch metadata). */
    fallback?: Record<string, unknown>;
    /** Blind transfer: whoever accepts also takes the customer off hold. */
    retrieveOnAccept?: boolean;
  }): Promise<void> {
    const inserted = await this.db
      .insert(ringOffer)
      .values({
        callId: input.callId,
        tenantId: input.tenantId,
        queueKey: input.queueKey,
        reason: input.reason ?? null,
        summary: input.summary ?? null,
        members: input.members,
        giveUpAt: input.giveUpAfterSec ? new Date(this.now() + input.giveUpAfterSec * 1000) : null,
        ringMs: input.ringSec ? input.ringSec * 1000 : this.offerTimeoutMs,
        fallback: input.fallback ?? null,
        retrieveOnAccept: input.retrieveOnAccept ?? false,
      })
      .onConflictDoNothing()
      .returning({ callId: ringOffer.callId });
    if (inserted.length > 0) await this.advance(input.callId, false);
  }

  /**
   * The ringing agent accepted. Returns `null` when the offer is no longer theirs
   * (it moved on, was cancelled, or never existed), so the route can answer 409.
   * On success the agent becomes `busy` on that call, `onAccepted` fires, and the
   * consumed offer row is returned (`retrieveOnAccept` drives the transfer unhold).
   */
  async accept(callId: string, userId: string): Promise<Offer | null> {
    const [deleted] = await this.db
      .delete(ringOffer)
      .where(and(eq(ringOffer.callId, callId), eq(ringOffer.currentUserId, userId)))
      .returning();
    if (!deleted) return null;
    await this.busy(callId, userId);
    await this.events.onAccepted(callId, userId);
    return deleted;
  }

  /**
   * Frees one user from a call without touching anyone else on it (a consult party was
   * dropped or left while the call goes on): wrap-up like {@link Routing.release}.
   */
  async free(userId: string, opts: { acwSec: number } = { acwSec: 0 }): Promise<void> {
    const a = await this.presenceOf(userId);
    if (!a || a.state !== 'busy') return;
    const now = new Date(this.now());
    await this.db
      .update(agentPresence)
      .set(
        opts.acwSec > 0
          ? {
              state: 'acw',
              reason: null,
              since: now,
              acwUntil: new Date(this.now() + opts.acwSec * 1000),
            }
          : { state: 'ready', reason: null, since: now, callId: null, acwUntil: null },
      )
      .where(eq(agentPresence.userId, userId));
    await this.publishPresence(a.tenantId);
  }

  /** Marks an online user `busy` on a call (accept, take-over). Offline users are ignored. */
  async busy(callId: string, userId: string): Promise<void> {
    const a = await this.presenceOf(userId);
    if (!a) return;
    await this.enter(userId, 'busy', null, callId);
    await this.publishPresence(a.tenantId);
  }

  /** The ringing agent declined: move on. Ignored unless the offer is currently theirs. */
  async decline(callId: string, userId: string): Promise<void> {
    const [o] = await this.db.select().from(ringOffer).where(eq(ringOffer.callId, callId));
    if (o?.currentUserId === userId) await this.advance(callId, false);
  }

  /**
   * The call ended or was otherwise resolved; stop ringing and free the agent, who goes
   * into wrap-up for `acwSec` seconds (`ready` right away when `0`).
   * Safe to call for calls that are not ringing and have no agent (no-op).
   */
  async release(callId: string, opts: { acwSec: number } = { acwSec: 0 }): Promise<void> {
    const [o] = await this.db.delete(ringOffer).where(eq(ringOffer.callId, callId)).returning();
    if (o?.currentUserId) {
      await this.send(o.currentUserId, { type: 'call.offer.cancelled', callId });
    }
    const now = new Date(this.now());
    const freed = await this.db
      .update(agentPresence)
      .set(
        opts.acwSec > 0
          ? {
              state: 'acw',
              reason: null,
              since: now,
              acwUntil: new Date(this.now() + opts.acwSec * 1000),
            }
          : { state: 'ready', reason: null, since: now, callId: null, acwUntil: null },
      )
      .where(eq(agentPresence.callId, callId))
      .returning();
    for (const a of freed) await this.publishPresence(a.tenantId);
  }

  /** Who the call is ringing right now, or `null`. */
  async ringing(callId: string): Promise<string | null> {
    const [o] = await this.db
      .select({ current: ringOffer.currentUserId })
      .from(ringOffer)
      .where(eq(ringOffer.callId, callId));
    return o?.current ?? null;
  }

  private async enter(
    userId: string,
    state: AgentState,
    reason: string | null,
    callId: string | null = null,
  ): Promise<void> {
    await this.db
      .update(agentPresence)
      .set({ state, reason, since: new Date(this.now()), callId, acwUntil: null })
      .where(eq(agentPresence.userId, userId));
  }

  private send(userId: string, message: ServerMessage): Promise<void> {
    return this.bus.publish({ kind: 'send', userId, message });
  }

  private publishPresence(tenantId: string): Promise<void> {
    return this.bus.publish({ kind: 'presence', tenantId });
  }

  /** Every offer currently ringing `userId` moves on (disconnect, sweep). */
  private async advanceOffersOf(userId: string, rona: boolean): Promise<void> {
    const mine = await this.db
      .select({ callId: ringOffer.callId })
      .from(ringOffer)
      .where(eq(ringOffer.currentUserId, userId));
    for (const { callId } of mine) await this.advance(callId, rona);
  }

  /**
   * One step of the ring cycle, under the offer's row lock so only one instance takes
   * it: cancel the current agent (if any; a timed-out ring parks them `not_ready` with
   * reason `RONA`), then either give up or ring the next candidate until `ringUntil`.
   * The timeout itself is detected by {@link Routing.tick}.
   */
  private async advance(callId: string, rona: boolean): Promise<void> {
    const step = await this.db.transaction(async (tx) => {
      const [o] = await tx
        .select()
        .from(ringOffer)
        .where(eq(ringOffer.callId, callId))
        .for('update', { skipLocked: true });
      if (!o) return null;
      const tried = [...o.tried];
      const cancelled = o.currentUserId;
      if (cancelled) tried.push(cancelled);
      const next =
        o.giveUpAt !== null && this.now() >= o.giveUpAt.getTime()
          ? undefined
          : await this.candidate(tx, o, tried);
      if (!next) {
        await tx.delete(ringOffer).where(eq(ringOffer.callId, callId));
        return { o, cancelled, next: undefined, ringFor: 0 };
      }
      const ringFor = Math.min(
        o.ringMs,
        o.giveUpAt === null ? o.ringMs : o.giveUpAt.getTime() - this.now(),
      );
      await tx
        .update(ringOffer)
        .set({ tried, currentUserId: next.userId, ringUntil: new Date(this.now() + ringFor) })
        .where(eq(ringOffer.callId, callId));
      return { o, cancelled, next, ringFor };
    });
    if (!step) return;
    const { o, cancelled, next, ringFor } = step;
    if (cancelled) {
      await this.send(cancelled, { type: 'call.offer.cancelled', callId });
      if (rona) {
        const missed = await this.presenceOf(cancelled);
        if (missed?.state === 'ready') {
          await this.enter(cancelled, 'not_ready', RONA_REASON);
          await this.publishPresence(missed.tenantId);
        }
      }
    }
    if (!next) {
      await this.events.onNobody(callId, o.tenantId, o.fallback);
      return;
    }
    await this.send(next.userId, {
      type: 'call.offer',
      callId,
      queueKey: o.queueKey,
      ...(o.reason !== null ? { reason: o.reason } : {}),
      ...(o.summary !== null ? { summary: o.summary } : {}),
      expiresAt: new Date(this.now() + ringFor).toISOString(),
    });
  }

  /** Earliest-connected ready queue member not yet tried and not ringing elsewhere. */
  private async candidate(
    tx: Pick<Db, 'select'>,
    o: Offer,
    tried: string[],
  ): Promise<{ userId: string } | undefined> {
    if (o.members.length === 0) return undefined;
    const [row] = await tx
      .select({ userId: agentPresence.userId })
      .from(agentPresence)
      .where(
        and(
          eq(agentPresence.tenantId, o.tenantId),
          eq(agentPresence.state, 'ready'),
          sql`${agentPresence.userId} = any(${pgArray(o.members)}::text[])`,
          sql`${agentPresence.userId} <> all(${pgArray(tried)}::text[])`,
          sql`not exists (select 1 from ${ringOffer} where ${ringOffer.currentUserId} = ${agentPresence.userId} and ${ringOffer.callId} <> ${o.callId})`,
        ),
      )
      .orderBy(agentPresence.seq)
      .limit(1);
    return row;
  }
}
