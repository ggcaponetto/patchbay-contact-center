/**
 * `/api/internal`: endpoints for the AI agent worker (`apps/agent`).
 *
 * The worker has no database of its own. Everything it learns while on a call
 * (transcript lines, events, who joined, the final summary) comes here, and when it wants
 * a human it long-polls `POST /calls/:id/escalate`. Authentication is a shared secret in
 * the `x-internal-secret` header, checked by a plugin-level `preHandler` so every route in
 * this file is covered. Never expose this prefix to browsers.
 *
 * Live data reaches the desks through the event hub: `transcript` and `call.updated`
 * are emitted here and turned into websocket messages by `ws.ts`.
 *
 * @see apps/api/src/routes/README.md
 * @packageDocumentation
 */
import { CallStatus, TranscriptSegmentInput, baseLanguage } from '@cc/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { Flow } from '../flow.ts';
import type { RouteDoc } from '../openapi.ts';
import {
  addEvent,
  addParticipant,
  addTranscript,
  getCall,
  markParticipantLeft,
  setCallStatus,
  setLanguage,
  setRequiredSkills,
  setSummary,
} from '../services/calls.ts';
import { getTenant } from '../services/tenants.ts';
import { parseBody } from './util.ts';

/** Plugin options for {@link internalRoutes}. */
export type InternalOpts = {
  db: Db;
  /** Expected value of the `x-internal-secret` header. */
  secret: string;
  hub: EventEmitter;
  flow: Flow;
};

/**
 * Endpoints called by the AI agent worker, protected by a shared secret header.
 *
 * All routes are under `/calls/:id` and answer 404 `not_found` for unknown calls and
 * 401 `unauthenticated` for a wrong secret.
 */
/** Body of `POST /calls/:id/events`. */
const EventBody = z.object({
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});
/** Body of `POST /calls/:id/participants`. */
const ParticipantBody = z.object({
  kind: z.enum(['ai', 'transcriber']),
  identity: z.string().min(1),
  left: z.boolean().default(false),
});
/** Body of `POST /calls/:id/escalate`. */
const EscalateBody = z.object({
  reason: z.string().min(1),
  summary: z.string().min(1),
  ringSec: z.number().int().min(5).max(120).default(20),
  /** Skill keys from the tenant catalogue (`TenantSettings.skills`); unknown keys are dropped. */
  skills: z.array(z.string().min(1).max(40)).max(10).optional(),
  /** The caller's language (BCP 47); stored as its base tag and routed as `lang:<tag>`. */
  language: z.string().min(2).max(35).optional(),
});
/** Body of `POST /calls/:id/status`. */
const StatusBody = z.object({ status: CallStatus, summary: z.string().optional() });
/** What `escalate` resolves with (`Flow`'s `Outcome`). */
const OutcomeResponse = z.union([
  z.object({ outcome: z.literal('accepted'), agentName: z.string() }),
  z.object({ outcome: z.literal('nobody') }),
]);
const internal = (doc: Omit<RouteDoc, 'access' | 'tag'>): { doc: RouteDoc } => ({
  doc: {
    access: 'internal',
    tag: 'internal',
    errors: ['401 unauthenticated', '404 not_found'],
    ...doc,
  },
});

export const internalRoutes: FastifyPluginAsync<InternalOpts> = async (
  app,
  { db, secret, hub, flow },
) => {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.headers['x-internal-secret'] !== secret) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    return undefined;
  });

  /** Loads the call or sends 404; handlers return `undefined` when it did. */
  const withCall = async (id: string, reply: FastifyReply) => {
    const row = await getCall(db, id);
    if (!row) {
      reply.code(404).send({ error: 'not_found' });
      return undefined;
    }
    return row;
  };

  /** The call row (status, room name, customer metadata). */
  app.get<{ Params: { id: string } }>(
    '/calls/:id',
    { config: internal({ summary: 'The call row (status, room name, customer metadata)' }) },
    async (request, reply) => withCall(request.params.id, reply),
  );

  /** Stores one transcript segment and pushes it to subscribed desks. Returns the row. */
  app.post<{ Params: { id: string } }>(
    '/calls/:id/transcript',
    {
      config: internal({
        summary: 'Store one transcript segment and push it to subscribed desks',
        body: TranscriptSegmentInput,
      }),
    },
    async (request, reply) => {
      const row = await withCall(request.params.id, reply);
      if (!row) return undefined;
      const body = parseBody(TranscriptSegmentInput, request.body, reply);
      if (!body) return undefined;
      const seg = await addTranscript(db, row.id, body);
      hub.emit('transcript', { tenantId: row.tenantId, callId: row.id, segment: body });
      return seg;
    },
  );

  /** Appends a free-form timeline event (`ai.joined`, `tool.called`, ...). */
  app.post<{ Params: { id: string } }>(
    '/calls/:id/events',
    { config: internal({ summary: 'Append a timeline event', body: EventBody }) },
    async (request, reply) => {
      const row = await withCall(request.params.id, reply);
      if (!row) return undefined;
      const body = parseBody(EventBody, request.body, reply);
      if (!body) return undefined;
      await addEvent(db, row.id, body.type, body.payload);
      return { ok: true };
    },
  );

  /** Records the AI (or transcriber) joining, or with `left: true`, leaving the room. */
  app.post<{ Params: { id: string } }>(
    '/calls/:id/participants',
    {
      config: internal({
        summary: 'Record the AI or transcriber joining (or, with `left`, leaving)',
        body: ParticipantBody,
      }),
    },
    async (request, reply) => {
      const row = await withCall(request.params.id, reply);
      if (!row) return undefined;
      const body = parseBody(ParticipantBody, request.body, reply);
      if (!body) return undefined;
      if (body.left) await markParticipantLeft(db, row.id, body.identity);
      else await addParticipant(db, { callId: row.id, kind: body.kind, identity: body.identity });
      return { ok: true };
    },
  );

  /**
   * Long-poll: resolves once a human accepted or nobody could take the call.
   * The response is `Flow`'s `Outcome`; the worker must use an HTTP timeout longer than
   * `ringSec` times the number of agents it expects to be rung.
   */
  app.post<{ Params: { id: string } }>(
    '/calls/:id/escalate',
    {
      config: internal({
        summary: 'Escalate to a human: long-polls until someone accepts or nobody can',
        body: EscalateBody,
        response: OutcomeResponse,
      }),
    },
    async (request, reply) => {
      const row = await withCall(request.params.id, reply);
      if (!row) return undefined;
      const body = parseBody(EscalateBody, request.body, reply);
      if (!body) return undefined;
      // Pin the AI's routing tags on the call before ringing: only catalogue keys (and
      // `lang:` skills) survive, merged with whatever the call already required.
      let skills: string[] | undefined;
      if (body.skills?.length) {
        const tenant = await getTenant(db, row.tenantId);
        const known = new Set((tenant?.settings.skills ?? []).map((s) => s.key));
        const dropped = body.skills.filter((k) => !known.has(k) && !k.startsWith('lang:'));
        if (dropped.length > 0) {
          request.log.warn({ callId: row.id, dropped }, 'escalate: unknown skill keys dropped');
        }
        skills = [
          ...new Set([...row.requiredSkills, ...body.skills.filter((k) => !dropped.includes(k))]),
        ];
        await setRequiredSkills(db, row.id, skills);
      }
      let language: string | undefined;
      if (body.language) {
        language = baseLanguage(body.language);
        if (language) await setLanguage(db, row.id, language);
      }
      return flow.escalate({
        callId: row.id,
        reason: body.reason,
        summary: body.summary,
        ringSec: body.ringSec,
        ...(skills ? { skills } : {}),
        ...(language ? { language } : {}),
      });
    },
  );

  /**
   * Sets the status (and optionally the AI summary). `ended` goes through `Flow.end`
   * so the room is deleted and ringing stops; other statuses are written directly.
   * Returns the updated call row.
   */
  app.post<{ Params: { id: string } }>(
    '/calls/:id/status',
    {
      config: internal({
        summary: 'Set the call status and optionally the AI summary',
        body: StatusBody,
      }),
    },
    async (request, reply) => {
      const row = await withCall(request.params.id, reply);
      if (!row) return undefined;
      const body = parseBody(StatusBody, request.body, reply);
      if (!body) return undefined;
      if (body.summary) await setSummary(db, row.id, body.summary);
      if (body.status === 'ended') {
        await flow.end(row.id);
        return getCall(db, row.id);
      }
      const updated = await setCallStatus(db, row.id, body.status);
      hub.emit('call.updated', {
        tenantId: row.tenantId,
        callId: row.id,
        status: body.status,
        heldAt: updated?.heldAt?.toISOString() ?? null,
      });
      return updated;
    },
  );
};
