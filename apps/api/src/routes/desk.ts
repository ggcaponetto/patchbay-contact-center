/**
 * `/api/desk`: what an agent or supervisor does with calls from the web desk.
 *
 * Listing and detail are read-only views; `accept`, `decline`, `join` and `leave` are
 * the REST half of the ringing protocol (the push half is the websocket in `ws.ts`).
 * Accepting is REST rather than a socket message because the answer is a LiveKit token.
 *
 * Authorization: `member` = signed in and has a membership in the selected tenant
 * (`x-tenant-id` header or the first membership); `supervisor` = member with the
 * `supervisor` role. Every call id is checked against the caller's tenant before use.
 *
 * @see apps/api/src/routes/README.md
 * @packageDocumentation
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { Flow } from '../flow.ts';
import { callDetail, listCalls } from '../services/calls.ts';
import type { Hook } from './admin.ts';
import { parseBody } from './util.ts';

/** Plugin options for {@link deskRoutes}. `authenticate` comes from `server.ts`. */
export type DeskOpts = { db: Db; authenticate: Hook; flow: Flow };

type P = { Params: { id: string } };

/**
 * Endpoints for signed-in agents and supervisors of a tenant.
 *
 * Errors: 401 `unauthenticated`, 403 `no_tenant` / `forbidden`, 404 `not_found`,
 * 409 `not_ringing_you` (accept) / `call_over` (accept, join).
 */
export const deskRoutes: FastifyPluginAsync<DeskOpts> = async (app, { db, authenticate, flow }) => {
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
