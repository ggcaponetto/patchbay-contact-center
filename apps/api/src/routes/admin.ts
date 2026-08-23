/**
 * `/api/admin`: tenant administration from the web desk.
 *
 * Two levels of access:
 *
 * - `POST /tenants` is for platform admins (emails in `ADMIN_EMAILS`): the only way to
 *   create a tenant besides the first-login bootstrap.
 * - Everything else needs the `tenant:read` (GET) or `tenant:write` permission in the
 *   tenant selected by `x-tenant-id`: settings, members, invites, queues and queue
 *   membership, embed keys; API keys need `api-keys:manage`.
 *
 * Handlers are thin: validate with zod, call `services/tenants.ts`, return the row.
 *
 * @see apps/api/src/routes/README.md
 * @packageDocumentation
 */
import { ApiKeyRequest, MembershipRole, QueueConfig, TenantSettings, UserSkill } from '@cc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { Access, RouteDoc } from '../openapi.ts';
import type { Guards } from '../server.ts';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apiKeys.ts';
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
  setQueueConfig,
  setQueueMembers,
  setSkills,
  skillsOf,
  updateSettings,
} from '../services/tenants.ts';
import { parseBody } from './util.ts';

/** Plugin options for {@link adminRoutes}. `guards` come from `server.ts`. */
export type AdminOpts = { db: Db; guards: Guards; adminEmails: string[] };

/**
 * Tenant administration: settings, members, invites, queues, embed keys. Supervisors only.
 *
 * Errors: 400 `invalid_body`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`.
 */
/** Bodies of the admin routes (also what the OpenAPI document shows). */
const TenantBody = z.object({ name: z.string().min(1).max(80) });
const InviteBody = z.object({ email: z.email(), role: MembershipRole });
const QueueBody = z.object({ key: z.string().min(1).max(40), name: z.string().min(1).max(80) });
const QueueMembersBody = z.object({ userIds: z.array(z.string()) });
/** Body of `PUT /members/:userId/skills`. */
const SkillsBody = z.object({ skills: z.array(UserSkill).max(50) });
const EmbedKeyBody = z.object({
  label: z.string().min(1).max(80),
  allowedOrigins: z.array(z.url()).default([]),
});
const doc = (
  summary: string,
  access: Access,
  extra: Partial<RouteDoc> = {},
): { doc: RouteDoc } => ({
  doc: { summary, access, tag: 'admin', ...extra },
});

export const adminRoutes: FastifyPluginAsync<AdminOpts> = async (
  app,
  { db, guards: { authenticate, authorize }, adminEmails },
) => {
  const read = authorize('tenant:read');
  const write = authorize('tenant:write');

  /** Platform admins only. The caller becomes supervisor of the new tenant. */
  app.post(
    '/tenants',
    {
      preHandler: authenticate,
      config: doc('Create a tenant (platform admins)', 'admin-email', {
        body: TenantBody,
        errors: ['403 forbidden'],
      }),
    },
    async (request, reply) => {
      if (!adminEmails.includes(request.ctx.user.email.toLowerCase())) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const body = parseBody(TenantBody, request.body, reply);
      if (!body) return undefined;
      return createTenant(db, body.name, request.ctx.user.id);
    },
  );

  app.get(
    '/tenant',
    { preHandler: read, config: doc('The tenant with its parsed settings', 'tenant:read') },
    async (request) => getTenant(db, request.ctx.tenantId),
  );

  /** Partial update; the merged result is re-validated against `TenantSettings`. */
  app.patch(
    '/tenant/settings',
    {
      preHandler: write,
      config: doc('Update tenant settings (partial, re-validated)', 'tenant:write', {
        body: TenantSettings.partial(),
        errors: ['400 invalid_body'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(TenantSettings.partial(), request.body, reply);
      if (!body) return undefined;
      return { settings: await updateSettings(db, request.ctx.tenantId, body) };
    },
  );

  app.get(
    '/members',
    { preHandler: read, config: doc('Members of the tenant with their role', 'tenant:read') },
    async (request) => listMembers(db, request.ctx.tenantId),
  );

  app.get(
    '/invites',
    { preHandler: read, config: doc('Invites of the tenant, pending and accepted', 'tenant:read') },
    async (request) => listInvites(db, request.ctx.tenantId),
  );

  /** Invites are by email; the membership is created when that email first signs in. */
  app.post(
    '/invites',
    {
      preHandler: write,
      config: doc('Invite someone by email', 'tenant:write', { body: InviteBody }),
    },
    async (request, reply) => {
      const body = parseBody(InviteBody, request.body, reply);
      if (!body) return undefined;
      return createInvite(db, request.ctx.tenantId, body.email, body.role);
    },
  );

  app.get(
    '/queues',
    { preHandler: read, config: doc('Queues with their member ids', 'tenant:read') },
    async (request) => listQueues(db, request.ctx.tenantId),
  );

  /** `key` is slugified (`"VIP Sales"` → `vip-sales`); it is what the embed passes as `queue`. */
  app.post(
    '/queues',
    {
      preHandler: write,
      config: doc('Create a queue (key is slugified)', 'tenant:write', { body: QueueBody }),
    },
    async (request, reply) => {
      const body = parseBody(QueueBody, request.body, reply);
      if (!body) return undefined;
      return createQueue(db, request.ctx.tenantId, body.key, body.name);
    },
  );

  /** Stores the queue's routing configuration: algorithm, required skills, language. */
  app.put<{ Params: { id: string } }>(
    '/queues/:id/config',
    {
      preHandler: write,
      config: doc('Set the routing configuration of a queue', 'tenant:write', {
        body: QueueConfig,
        errors: ['404 not_found'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(QueueConfig, request.body, reply);
      if (!body) return undefined;
      const ok = await setQueueConfig(db, request.ctx.tenantId, request.params.id, body);
      return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    },
  );

  /** Skills of one member, for the Settings screen. */
  app.get<{ Params: { userId: string } }>(
    '/members/:userId/skills',
    { preHandler: read, config: doc('Skills of a member with proficiency', 'tenant:read') },
    async (request) => skillsOf(db, request.ctx.tenantId, request.params.userId),
  );

  /** Replaces a member's skills (reskilling on the fly; applies to the next ring). */
  app.put<{ Params: { userId: string } }>(
    '/members/:userId/skills',
    {
      preHandler: write,
      config: doc('Replace the skills of a member', 'tenant:write', { body: SkillsBody }),
    },
    async (request, reply) => {
      const body = parseBody(SkillsBody, request.body, reply);
      if (!body) return undefined;
      await setSkills(db, request.ctx.tenantId, request.params.userId, body.skills);
      return { ok: true };
    },
  );

  /** Replaces the queue's member list. Agents must reconnect their desk to pick it up. */
  app.put<{ Params: { id: string } }>(
    '/queues/:id/members',
    {
      preHandler: write,
      config: doc('Replace the member list of a queue', 'tenant:write', {
        body: QueueMembersBody,
        errors: ['404 not_found'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(QueueMembersBody, request.body, reply);
      if (!body) return undefined;
      const ok = await setQueueMembers(db, request.ctx.tenantId, request.params.id, body.userIds);
      return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    },
  );

  app.get(
    '/embed-keys',
    { preHandler: read, config: doc('Embed keys of the tenant', 'tenant:read') },
    async (request) => listEmbedKeys(db, request.ctx.tenantId),
  );

  /** `allowedOrigins` must be full origins (`https://example.com`); empty = any origin. */
  app.post(
    '/embed-keys',
    {
      preHandler: write,
      config: doc('Create an embed key', 'tenant:write', { body: EmbedKeyBody }),
    },
    async (request, reply) => {
      const body = parseBody(EmbedKeyBody, request.body, reply);
      if (!body) return undefined;
      return createEmbedKey(db, request.ctx.tenantId, body.label, body.allowedOrigins);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/embed-keys/:id',
    {
      preHandler: write,
      config: doc('Delete an embed key', 'tenant:write', { errors: ['404 not_found'] }),
    },
    async (request, reply) => {
      const ok = await deleteEmbedKey(db, request.ctx.tenantId, request.params.id);
      return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    },
  );

  /** API keys: listing needs `tenant:read`, creating and revoking `api-keys:manage`. */
  const keys = authorize('api-keys:manage');
  app.get(
    '/api-keys',
    { preHandler: read, config: doc('API keys of the tenant (never the secret)', 'tenant:read') },
    async (request) => listApiKeys(db, request.ctx.tenantId),
  );
  /** Returns the key once, in `secret`; only a hash is stored. */
  app.post(
    '/api-keys',
    {
      preHandler: keys,
      config: doc('Create an API key; the secret is returned once', 'api-keys:manage', {
        body: ApiKeyRequest,
      }),
    },
    async (request, reply) => {
      const body = parseBody(ApiKeyRequest, request.body, reply);
      if (!body) return undefined;
      return createApiKey(db, request.ctx.tenantId, body.name, body.permissions);
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api-keys/:id',
    {
      preHandler: keys,
      config: doc('Revoke an API key', 'api-keys:manage', { errors: ['404 not_found'] }),
    },
    async (request, reply) => {
      const ok = await revokeApiKey(db, request.ctx.tenantId, request.params.id);
      return ok ? { ok: true } : reply.code(404).send({ error: 'not_found' });
    },
  );
};
