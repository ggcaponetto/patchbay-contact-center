/**
 * Live tenant statistics for the supervisor dashboard and the wallboard, plus the
 * threshold alerts computed against `TenantSettings.alerts`. Everything is derived on
 * demand from the `call` table and the routing snapshot — no counters to keep in sync.
 *
 * @see apps/api/src/services/README.md
 * @packageDocumentation
 */
import type { AgentPresence, TenantSettings } from '@cc/shared';
import { and, eq, gte, ne } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { call, callParticipant } from '../db/schema.ts';

/** What `GET /api/desk/stats` returns; see {@link tenantStats}. */
export type TenantStats = {
  /** Calls currently in `waiting_human` (ringing desks). */
  waiting: number;
  /** Age in seconds of the oldest waiting call, `0` when none wait. */
  longestWaitSec: number;
  /** Calls in progress (any status but `ended`), including the waiting ones. */
  active: number;
  /** Age in seconds of the oldest active call. */
  longestCallSec: number;
  /** Agents online right now, by state. */
  agents: { ready: number; notReady: number; busy: number; acw: number };
  /** Since local midnight: totals and the average handle time of ended calls. */
  today: { calls: number; answered: number; avgHandleSec: number };
  /** Human-readable threshold breaches, empty when all is well. */
  alerts: string[];
};

/**
 * Computes the {@link TenantStats} snapshot.
 *
 * Wait age is measured from the call's start (the POC does not keep a per-status
 * timestamp), which is exact for human-first calls and an upper bound after an AI
 * handoff. "Answered" counts calls a human participated in.
 *
 * @param db - Drizzle client.
 * @param tenantId - Tenant to report on.
 * @param agents - Routing snapshot (`Routing.snapshot`) of the tenant.
 * @param settings - Tenant settings; `alerts` thresholds of `0` are off.
 * @param now - Clock override for tests, defaults to `Date.now()`.
 */
export async function tenantStats(
  db: Db,
  tenantId: string,
  agents: AgentPresence[],
  settings: TenantSettings,
  now = Date.now(),
): Promise<TenantStats> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const [open, today, humanCalls] = await Promise.all([
    db
      .select()
      .from(call)
      .where(and(eq(call.tenantId, tenantId), ne(call.status, 'ended'))),
    db
      .select()
      .from(call)
      .where(and(eq(call.tenantId, tenantId), gte(call.startedAt, midnight))),
    db
      .selectDistinct({ callId: callParticipant.callId })
      .from(callParticipant)
      .innerJoin(call, eq(call.id, callParticipant.callId))
      .where(
        and(
          eq(call.tenantId, tenantId),
          gte(call.startedAt, midnight),
          eq(callParticipant.kind, 'human'),
        ),
      ),
  ]);
  const ageSec = (c: { startedAt: Date }) => Math.max(0, (now - c.startedAt.getTime()) / 1000);
  const waiting = open.filter((c) => c.status === 'waiting_human');
  const ended = today.filter((c) => c.status === 'ended' && c.endedAt !== null);
  const handle = ended.map((c) => (c.endedAt!.getTime() - c.startedAt.getTime()) / 1000);
  const by = (state: AgentPresence['state']) => agents.filter((a) => a.state === state).length;
  const stats: TenantStats = {
    waiting: waiting.length,
    longestWaitSec: Math.round(Math.max(0, ...waiting.map(ageSec))),
    active: open.length,
    longestCallSec: Math.round(Math.max(0, ...open.map(ageSec))),
    agents: { ready: by('ready'), notReady: by('not_ready'), busy: by('busy'), acw: by('acw') },
    today: {
      calls: today.length,
      answered: humanCalls.length,
      avgHandleSec: handle.length
        ? Math.round(handle.reduce((a, b) => a + b, 0) / handle.length)
        : 0,
    },
    alerts: [],
  };
  const t = settings.alerts;
  if (t.maxWaiting > 0 && stats.waiting >= t.maxWaiting) {
    stats.alerts.push(`${stats.waiting} calls waiting (limit ${t.maxWaiting})`);
  }
  if (t.maxWaitSec > 0 && stats.longestWaitSec >= t.maxWaitSec) {
    stats.alerts.push(`longest wait ${stats.longestWaitSec}s (limit ${t.maxWaitSec}s)`);
  }
  if (t.maxCallSec > 0 && stats.longestCallSec >= t.maxCallSec) {
    stats.alerts.push(`longest call ${stats.longestCallSec}s (limit ${t.maxCallSec}s)`);
  }
  return stats;
}
