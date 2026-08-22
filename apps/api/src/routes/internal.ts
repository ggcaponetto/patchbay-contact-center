import { CallStatus, TranscriptSegmentInput } from '@cc/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { Flow } from '../flow.ts';
import {
  addEvent,
  addParticipant,
  addTranscript,
  getCall,
  markParticipantLeft,
  setCallStatus,
  setSummary,
} from '../services/calls.ts';
import { parseBody } from './util.ts';

export type InternalOpts = {
  db: Db;
  secret: string;
  hub: EventEmitter;
  flow: Flow;
};

/** Endpoints called by the AI agent worker, protected by a shared secret header. */
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

  const withCall = async (id: string, reply: FastifyReply) => {
    const row = await getCall(db, id);
    if (!row) {
      reply.code(404).send({ error: 'not_found' });
      return undefined;
    }
    return row;
  };

  app.get<{ Params: { id: string } }>('/calls/:id', async (request, reply) =>
    withCall(request.params.id, reply),
  );

  app.post<{ Params: { id: string } }>('/calls/:id/transcript', async (request, reply) => {
    const row = await withCall(request.params.id, reply);
    if (!row) return undefined;
    const body = parseBody(TranscriptSegmentInput, request.body, reply);
    if (!body) return undefined;
    const seg = await addTranscript(db, row.id, body);
    hub.emit('transcript', { tenantId: row.tenantId, callId: row.id, segment: body });
    return seg;
  });

  app.post<{ Params: { id: string } }>('/calls/:id/events', async (request, reply) => {
    const row = await withCall(request.params.id, reply);
    if (!row) return undefined;
    const body = parseBody(
      z.object({ type: z.string().min(1), payload: z.record(z.string(), z.unknown()).default({}) }),
      request.body,
      reply,
    );
    if (!body) return undefined;
    await addEvent(db, row.id, body.type, body.payload);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/calls/:id/participants', async (request, reply) => {
    const row = await withCall(request.params.id, reply);
    if (!row) return undefined;
    const body = parseBody(
      z.object({
        kind: z.enum(['ai', 'transcriber']),
        identity: z.string().min(1),
        left: z.boolean().default(false),
      }),
      request.body,
      reply,
    );
    if (!body) return undefined;
    if (body.left) await markParticipantLeft(db, row.id, body.identity);
    else await addParticipant(db, { callId: row.id, kind: body.kind, identity: body.identity });
    return { ok: true };
  });

  /** Long-poll: resolves once a human accepted or nobody could take the call. */
  app.post<{ Params: { id: string } }>('/calls/:id/escalate', async (request, reply) => {
    const row = await withCall(request.params.id, reply);
    if (!row) return undefined;
    const body = parseBody(
      z.object({
        reason: z.string().min(1),
        summary: z.string().min(1),
        ringSec: z.number().int().min(5).max(120).default(20),
      }),
      request.body,
      reply,
    );
    if (!body) return undefined;
    return flow.escalate(row.id, body.reason, body.summary, body.ringSec);
  });

  app.post<{ Params: { id: string } }>('/calls/:id/status', async (request, reply) => {
    const row = await withCall(request.params.id, reply);
    if (!row) return undefined;
    const body = parseBody(
      z.object({ status: CallStatus, summary: z.string().optional() }),
      request.body,
      reply,
    );
    if (!body) return undefined;
    if (body.summary) await setSummary(db, row.id, body.summary);
    if (body.status === 'ended') {
      await flow.end(row.id);
      return getCall(db, row.id);
    }
    const updated = await setCallStatus(db, row.id, body.status);
    hub.emit('call.updated', { tenantId: row.tenantId, callId: row.id, status: body.status });
    return updated;
  });
};
