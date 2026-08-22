/**
 * `/api/admin`: tenant administration from the web desk.
 *
 * Two levels of access:
 *
 * - `POST /tenants` is for platform admins (emails in `ADMIN_EMAILS`): the only way to
 *   create a tenant besides the first-login bootstrap.
 * - Everything else is for supervisors of the tenant selected by `x-tenant-id`:
 *   settings, members, invites, queues and queue membership, embed keys.
 *
 * Handlers are thin: validate with zod, call `services/tenants.ts`, return the row.
 *
 * @see apps/api/src/routes/README.md
 * @packageDocumentation
 */
import { MembershipRole, TenantSettings } from '@cc/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import {
  createEmbedKey,
  createInvite,
  createQueue,
  createTenant,
  deleteEmbedKey,
  getTenant,
  listEmbedKeys,
  listInvites,
  listMembers,
  listQueues,
  setQueueMembers,
  updateSettings,
} from '../services/tenants.ts';
import { parseBody } from './util.ts';

/**
 * A Fastify `preHandler`. Returns `undefined` to continue, or the result of
 * `reply.send()` after rejecting the request.
 */
export type Hook = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** Plugin options for {@link adminRoutes}. */
export type AdminOpts = { db: Db; authenticate: Hook; adminEmails: string[] };

/**
 * Tenant administration: settings, members, invites, queues, embed keys. Supervisors only.
 *
 * Errors: 400 `invalid_body`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`.
 */
export const adminRoutes: FastifyPluginAsync<AdminOpts> = async (
  app,
  { db, authenticate, adminEmails },
) => {
  const supervisor: Hook = async (request, reply) => {
    const denied = await authenticate(request, reply);
    if (denied !== undefined) return denied;
    if (request.ctx.role !== 'supervisor' || !request.ctx.tenantId) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return undefined;
  };

  /** Platform admins only. The caller becomes supervisor of the new tenant. */
  app.post('/tenants', { preHandler: authenticate }, async (request, reply) => {
    if (!adminEmails.includes(request.ctx.user.email.toLowerCase())) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const body = parseBody(z.object({ name: z.string().min(1).max(80) }), request.body, reply);
    if (!body) return undefined;
    return createTenant(db, body.name, request.ctx.user.id);
  });

  app.get('/tenant', { preHandler: supervisor }, async (request) =>
    getTenant(db, request.ctx.tenantId),
  );

  /** Partial update; the merged result is re-validated against `TenantSettings`. */
  app.patch('/tenant/settings', { preHandler: supervisor }, async (request, reply) => {
    const body = parseBody(TenantSettings.partial(), request.body, reply);
    if (!body) return undefined;
    return { settings: await updateSettings(db, request.ctx.tenantId, body) };
  });

  app.get('/members', { preHandler: supervisor }, async (request) =>
    listMembers(db, request.ctx.tenantId),
  );

  app.get('/invites', { preHandler: supervisor }, async (request) =>
    listInvites(db, request.ctx.tenantId),
  );

  /** Invites are by email; the membership is created when that email first signs in. */
  app.post('/invites', { preHandler: supervisor }, async (request, reply) => {
    const body = parseBody(
      z.object({ email: z.email(), role: MembershipRole }),
      request.body,
      reply,
    );
    if (!body) return undefined;
    return createInvite(db, request.ctx.tenantId, body.email, body.role);
  });

  app.get('/queues', { preHandler: supervisor }, async (request) =>
    listQueues(db, request.ctx.tenantId),
  );

  /** `key` is slugified (`"VIP Sales"` → `vip-sales`); it is what the embed passes as `queue`. */
  app.post('/queues', { preHandler: supervisor }, async (request, reply) => {
    const body = parseBody(
      z.object({ key: z.string().min(1).max(40), name: z.string().min(1).max(80) }),
      request.body,
      reply,
    );
    if (!body) return undefined;
    return createQueue(db, request.ctx.tenantId, body.key, body.name);
  });

  /** Replaces the queue's member list. Agents must reconnect their desk to pick it up. */
  app.put<{ Params: { id: string } }>(
    '/queues/:id/members',
    { preHandler: supervisor },
    async (request, reply) => {
      const body = parseBody(z.object({ userIds: z.array(z.string()) }), request.body, reply);
      if (!body) return undefined;
      const ok = await setQueueMembers(db, request.ctx.tenantId, request.params.id, body.userIds);
      return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    },
  );

  app.get('/embed-keys', { preHandler: supervisor }, async (request) =>
    listEmbedKeys(db, request.ctx.tenantId),
  );

  /** `allowedOrigins` must be full origins (`https://example.com`); empty = any origin. */
  app.post('/embed-keys', { preHandler: supervisor }, async (request, reply) => {
    const body = parseBody(
      z.object({ label: z.string().min(1).max(80), allowedOrigins: z.array(z.url()).default([]) }),
      request.body,
      reply,
    );
    if (!body) return undefined;
    return createEmbedKey(db, request.ctx.tenantId, body.label, body.allowedOrigins);
  });

  app.delete<{ Params: { id: string } }>(
    '/embed-keys/:id',
    { preHandler: supervisor },
    async (request, reply) => {
      const ok = await deleteEmbedKey(db, request.ctx.tenantId, request.params.id);
      return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    },
  );
};
