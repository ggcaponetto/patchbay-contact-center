/**
 * `/api/public`: the unauthenticated surface used by the embeddable call button.
 *
 * A website embeds the button with a tenant's public embed key (`pk_...`). Pressing it
 * calls `POST /api/public/calls`, which is the birth of every call: the row is created,
 * the room name is derived, and the customer receives a LiveKit token. Depending on the
 * tenant's `routingMode` the AI is dispatched immediately (`ai-first`) or the humans are
 * rung first (`human-first`, see `Flow.humanFirst`).
 *
 * Security relies on two things only: the embed key must exist, and the request's
 * `Origin` must be in the key's allow-list (an empty list allows any origin).
 *
 * @see apps/api/src/routes/README.md
 * @packageDocumentation
 */
import { type DispatchMetadata, roomNameFor } from '@cc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { Flow } from '../flow.ts';
import type { LiveKit } from '../livekit.ts';
import { addEvent, addParticipant, createCall, setCallStatus } from '../services/calls.ts';
import { originAllowed, resolveEmbedKey } from '../services/tenants.ts';
import { parseBody } from './util.ts';

/** Plugin options for {@link publicRoutes}. */
export type PublicOpts = { db: Db; livekit: LiveKit; flow: Flow; hub: EventEmitter };

/** Body of `POST /calls`. `customerMeta` is opaque and forwarded to the AI agent. */
const CreateCallBody = z.object({
  embedKey: z.string().min(1),
  queue: z.string().min(1).default('support'),
  /** BCP 47 language tag from the website (`<cc-call-button language="de-CH">`). */
  language: z.string().min(2).max(35).optional(),
  customerMeta: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Unauthenticated endpoints used by the embeddable call button.
 *
 * `POST /calls` → `{ callId, roomName, token, url }`; errors: 400 `invalid_body`,
 * 404 `unknown_embed_key_or_queue`, 403 `origin_not_allowed`.
 */
export const publicRoutes: FastifyPluginAsync<PublicOpts> = async (
  app,
  { db, livekit, flow, hub },
) => {
  app.post(
    '/calls',
    {
      config: {
        doc: {
          summary: 'Start a call from the embedded button; returns the LiveKit token',
          access: 'public',
          tag: 'public',
          body: CreateCallBody,
          response: z.object({
            callId: z.string(),
            roomName: z.string(),
            token: z.string(),
            url: z.string(),
          }),
          errors: ['400 invalid_body', '403 origin_not_allowed', '404 unknown_embed_key_or_queue'],
        },
      },
    },
    async (request, reply) => {
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
        ...(body.language ? { language: body.language } : {}),
      });
      const identity = `customer:${id}`;
      await addParticipant(db, { callId: id, kind: 'customer', identity });
      await addEvent(db, id, 'call.created', {
        queue: queue.key,
        origin: request.headers.origin ?? null,
      });

      // Same payload whether the AI starts now (token room config) or later (dispatch API).
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
      const status = aiFirst ? 'ai' : 'waiting_human';
      await setCallStatus(db, id, status);
      // Desks refetch their call lists on `call.updated`: this is how a new call shows up.
      hub.emit('call.updated', { tenantId: resolved.key.tenantId, callId: id, status });
      if (!aiFirst) void flow.humanFirst(id, metadata);
      return { callId: id, roomName, token, url: livekit.url };
    },
  );
};
