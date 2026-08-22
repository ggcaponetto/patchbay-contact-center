import { type DispatchMetadata, roomNameFor } from '@cc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { LiveKit } from '../livekit.ts';
import { addEvent, addParticipant, createCall, setCallStatus } from '../services/calls.ts';
import { originAllowed, resolveEmbedKey } from '../services/tenants.ts';
import { parseBody } from './util.ts';

export type PublicOpts = { db: Db; livekit: LiveKit };

const CreateCallBody = z.object({
  embedKey: z.string().min(1),
  queue: z.string().min(1).default('support'),
  customerMeta: z.record(z.string(), z.unknown()).default({}),
});

/** Unauthenticated endpoints used by the embeddable call button. */
export const publicRoutes: FastifyPluginAsync<PublicOpts> = async (app, { db, livekit }) => {
  app.post('/calls', async (request, reply) => {
    const body = parseBody(CreateCallBody, request.body, reply);
    if (!body) return undefined;
    const resolved = await resolveEmbedKey(db, body.embedKey, body.queue);
    if (!resolved) return reply.code(404).send({ error: 'unknown_embed_key_or_queue' });
    if (!originAllowed(resolved.key.allowedOrigins, request.headers.origin)) {
      return reply.code(403).send({ error: 'origin_not_allowed' });
    }
    const { tenant, queue } = resolved;
    const id = randomUUID();
    const roomName = roomNameFor(tenant.id, id);
    await createCall(db, {
      id,
      tenantId: tenant.id,
      queueId: queue.id,
      roomName,
      customerMeta: body.customerMeta,
    });
    const identity = `customer:${id}`;
    await addParticipant(db, { callId: id, kind: 'customer', identity });
    await addEvent(db, id, 'call.created', {
      queue: queue.key,
      origin: request.headers.origin ?? null,
    });

    const metadata: DispatchMetadata = {
      callId: id,
      tenantId: tenant.id,
      queueKey: queue.key,
      settings: tenant.settings,
      customerMeta: body.customerMeta,
    };
    const aiFirst = tenant.settings.routingMode === 'ai-first';
    const token = await livekit.createToken({
      room: roomName,
      identity,
      name: 'Customer',
      attributes: { role: 'customer' },
      ...(aiFirst ? { dispatchMetadata: JSON.stringify(metadata) } : {}),
    });
    await setCallStatus(db, id, aiFirst ? 'ai' : 'waiting_human');
    return { callId: id, roomName, token, url: livekit.url };
  });
};
