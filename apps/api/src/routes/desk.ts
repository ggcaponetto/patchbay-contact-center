import type { FastifyPluginAsync } from 'fastify';
import type { Db } from '../db/client.ts';
import { callDetail, listCalls } from '../services/calls.ts';
import type { Hook } from './admin.ts';

export type DeskOpts = { db: Db; authenticate: Hook };

/** Endpoints for signed-in agents and supervisors of a tenant. */
export const deskRoutes: FastifyPluginAsync<DeskOpts> = async (app, { db, authenticate }) => {
  const member: Hook = async (request, reply) => {
    const denied = await authenticate(request, reply);
    if (denied !== undefined) return denied;
    if (!request.ctx.tenantId) return reply.code(403).send({ error: 'no_tenant' });
    return undefined;
  };

  app.get('/calls', { preHandler: member }, async (request) => listCalls(db, request.ctx.tenantId));

  app.get<{ Params: { id: string } }>(
    '/calls/:id',
    { preHandler: member },
    async (request, reply) => {
      const detail = await callDetail(db, request.ctx.tenantId, request.params.id);
      return detail ?? reply.code(404).send({ error: 'not_found' });
    },
  );
};
