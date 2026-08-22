import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { Flow } from '../flow.ts';
import { callDetail, listCalls } from '../services/calls.ts';
import type { Hook } from './admin.ts';
import { parseBody } from './util.ts';

export type DeskOpts = { db: Db; authenticate: Hook; flow: Flow };

type P = { Params: { id: string } };

/** Endpoints for signed-in agents and supervisors of a tenant. */
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

  app.get('/calls', { preHandler: member }, async (request) => listCalls(db, request.ctx.tenantId));

  app.get<P>('/calls/:id', { preHandler: member }, async (request, reply) => {
    const detail = await callDetail(db, request.ctx.tenantId, request.params.id);
    return detail ?? reply.code(404).send({ error: 'not_found' });
  });

  /** Accept the offer currently ringing this agent; returns the LiveKit token to join. */
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

  app.post<P>('/calls/:id/decline', { preHandler: member }, async (request) => {
    flow.routing.decline(request.params.id, request.ctx.user.id);
    return { ok: true };
  });

  /** Supervisors: listen in silently or take the call over. */
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
