/**
 * `/api/desk`: what an agent or supervisor does with calls from the web desk.
 *
 * Listing and detail are read-only views; `accept`, `decline`, `join` and `leave` are
 * the REST half of the ringing protocol (the push half is the websocket in `ws.ts`).
 * Accepting is REST rather than a socket message because the answer is a LiveKit token.
 * Agent states (`/state`, wrap-up, the supervisor's force-state) are REST too: every
 * operation of the desk has a public API.
 *
 * Authorization: `member` = signed in and has a membership in the selected tenant
 * (`x-tenant-id` header or the first membership); `supervisor` = member with the
 * `supervisor` role. Every call id is checked against the caller's tenant before use.
 *
 * @see apps/api/src/routes/README.md
 * @packageDocumentation
 */
import { AgentStateRequest } from '@cc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { Flow } from '../flow.ts';
import { callDetail, listCalls } from '../services/calls.ts';
import { getTenant } from '../services/tenants.ts';
import type { DeskSockets } from '../ws.ts';
import type { Hook } from './admin.ts';
import { parseBody } from './util.ts';

/** Plugin options for {@link deskRoutes}. `authenticate` comes from `server.ts`. */
export type DeskOpts = { db: Db; authenticate: Hook; flow: Flow; sockets: DeskSockets };

type P = { Params: { id: string } };

/** Body of the supervisor's force-state route: an agent state request, or log the agent out. */
const ForceStateBody = z.union([AgentStateRequest, z.object({ state: z.literal('logged_out') })]);

/**
 * Endpoints for signed-in agents and supervisors of a tenant.
 *
 * Errors: 401 `unauthenticated`, 403 `no_tenant` / `forbidden`, 404 `not_found`,
 * 409 `not_ringing_you` (accept) / `call_over` (accept, join) / `offline`, `on_call`,
 * `not_in_acw` (states).
 */
export const deskRoutes: FastifyPluginAsync<DeskOpts> = async (
  app,
  { db, authenticate, flow, sockets },
) => {
  const member: Hook = async (request, reply) => {
    const denied = await authenticate(request, reply);
    if (denied !== undefined) return denied;
    if (!request.ctx.tenantId) return reply.code(403).send({ error: 'no_tenant' });
    return undefined;
  };
  const supervisor: Hook = async (request, reply) => {
    const denied = await member(request, reply);
    if (denied !== undefined) return denied;
    if (request.ctx.role !== 'supervisor') return reply.code(403).send({ error: 'forbidden' });
    return undefined;
  };

  /** The tenant settings every member needs at the desk (reason codes, wrap-up length). */
  app.get('/settings', { preHandler: member }, async (request) => {
    const tenant = await getTenant(db, request.ctx.tenantId);
    return {
      notReadyReasons: tenant?.settings.notReadyReasons ?? [],
      acwSec: tenant?.settings.acwSec ?? 0,
    };
  });

  /** Everyone online in the tenant with their state (the `presence` message, on demand). */
  app.get('/agents', { preHandler: member }, async (request) =>
    flow.routing.snapshot(request.ctx.tenantId),
  );

  /** My own presence, or 404 when I have no desk socket open. */
  const mine = (userId: string, tenantId: string) =>
    flow.routing.snapshot(tenantId).find((a) => a.userId === userId);

  /** Go `ready` or `not_ready` (with a reason code). 409 `offline` / `on_call`. */
  app.post('/state', { preHandler: member }, async (request, reply) => {
    const body = parseBody(AgentStateRequest, request.body, reply);
    if (!body) return undefined;
    const err = flow.routing.setState(request.ctx.user.id, body.state, body.reason);
    if (err) return reply.code(409).send({ error: err });
    return mine(request.ctx.user.id, request.ctx.tenantId);
  });

  /** Add the tenant's `acwSec` to my running wrap-up. 409 `not_in_acw`. */
  app.post('/acw/extend', { preHandler: member }, async (request, reply) => {
    const tenant = await getTenant(db, request.ctx.tenantId);
    const ok = flow.routing.extendAcw(request.ctx.user.id, tenant?.settings.acwSec ?? 30);
    if (!ok) return reply.code(409).send({ error: 'not_in_acw' });
    return mine(request.ctx.user.id, request.ctx.tenantId);
  });

  /** Finish wrap-up early: straight to `ready`. */
  app.post('/acw/done', { preHandler: member }, async (request, reply) => {
    const me = mine(request.ctx.user.id, request.ctx.tenantId);
    if (me?.state !== 'acw') return reply.code(409).send({ error: 'not_in_acw' });
    flow.routing.setState(request.ctx.user.id, 'ready');
    return mine(request.ctx.user.id, request.ctx.tenantId);
  });

  /**
   * Supervisors: force an online agent of the tenant `ready` / `not_ready` (which also
   * ends a wrap-up), or log them out (their desks are disconnected with a `logout` message).
   * 404 when the agent is not online in this tenant, 409 `on_call`.
   */
  app.post<{ Params: { userId: string } }>(
    '/agents/:userId/state',
    { preHandler: supervisor },
    async (request, reply) => {
      const body = parseBody(ForceStateBody, request.body, reply);
      if (!body) return undefined;
      const { userId } = request.params;
      const target = flow.routing.presenceOf(userId);
      if (!target || target.tenantId !== request.ctx.tenantId) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (body.state === 'logged_out') {
        sockets.closeUser(userId, request.ctx.user.name);
        flow.routing.removePresence(userId);
        return { ok: true };
      }
      const err = flow.routing.setState(userId, body.state, body.reason);
      if (err) return reply.code(409).send({ error: err });
      return mine(userId, request.ctx.tenantId);
    },
  );

  /** Latest 50 calls of the tenant, newest first. */
  app.get('/calls', { preHandler: member }, async (request) => listCalls(db, request.ctx.tenantId));

  /** One call with participants, transcript and events. */
  app.get<P>('/calls/:id', { preHandler: member }, async (request, reply) => {
    const detail = await callDetail(db, request.ctx.tenantId, request.params.id);
    return detail ?? reply.code(404).send({ error: 'not_found' });
  });

  /**
   * Accept the offer currently ringing this agent; returns the LiveKit token to join.
   * `routing.accept` is the gate: only the agent being rung right now gets through.
   */
  app.post<P>('/calls/:id/accept', { preHandler: member }, async (request, reply) => {
    const { id } = request.params;
    if (!(await callDetail(db, request.ctx.tenantId, id))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    if (!flow.routing.accept(id, request.ctx.user.id)) {
      return reply.code(409).send({ error: 'not_ringing_you' });
    }
    const joined = await flow.join(id, request.ctx.user, 'agent');
    return joined ?? reply.code(409).send({ error: 'call_over' });
  });

  /** Same as the `offer.decline` socket message; always `{ ok: true }`. */
  app.post<P>('/calls/:id/decline', { preHandler: member }, async (request) => {
    flow.routing.decline(request.params.id, request.ctx.user.id);
    return { ok: true };
  });

  /** Supervisors: listen in silently or take the call over. Returns a LiveKit token. */
  app.post<P>('/calls/:id/join', { preHandler: supervisor }, async (request, reply) => {
    const body = parseBody(z.object({ mode: z.enum(['listen', 'takeover']) }), request.body, reply);
    if (!body) return undefined;
    const { id } = request.params;
    if (!(await callDetail(db, request.ctx.tenantId, id))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const joined = await flow.join(id, request.ctx.user, body.mode);
    return joined ?? reply.code(409).send({ error: 'call_over' });
  });

  /** The desk left the room. A human agent leaving ends the call. */
  app.post<P>('/calls/:id/leave', { preHandler: member }, async (request, reply) => {
    const body = parseBody(
      z.object({ role: z.enum(['human', 'supervisor']).default('human') }),
      request.body ?? {},
      reply,
    );
    if (!body) return undefined;
    const { id } = request.params;
    if (!(await callDetail(db, request.ctx.tenantId, id))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    await flow.leave(id, request.ctx.user, body.role);
    return { ok: true };
  });
};
