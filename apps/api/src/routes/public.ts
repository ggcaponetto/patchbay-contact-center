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
 * `GET /media/:id` serves uploaded sound files without any authentication: ids are random
 * UUIDs (unguessable) and sounds are not sensitive — they are played to anonymous callers
 * by design, and the embed button and the media worker need them without credentials.
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
import { openState } from '../services/hours.ts';
import { readMediaAsset } from '../services/mediaAssets.ts';
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
 * `POST /calls` → `{ callId, roomName, token, url, sounds }`; errors: 400 `invalid_body`,
 * 404 `unknown_embed_key_or_queue`, 403 `origin_not_allowed`. `GET /media/:id` streams an
 * uploaded sound (404 `not_found`).
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
            /** Tenant sounds the embed plays itself (ringback while waiting). */
            sounds: z.object({ ringback: z.string().optional() }),
          }),
          errors: [
            '400 invalid_body',
            '403 origin_not_allowed / closed',
            '404 unknown_embed_key_or_queue',
          ],
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
      // Business hours: while closed (schedule, holiday, forced, emergency) no call
      // is created; the embed shows the configured message instead of connecting.
      const state = openState(tenant.settings.hours);
      if (!state.open) return reply.code(403).send({ error: 'closed', message: state.message });
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
        ...(body.language ? { language: body.language } : {}),
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
      const { ringback } = tenant.settings.sounds;
      return {
        callId: id,
        roomName,
        token,
        url: livekit.url,
        sounds: { ...(ringback ? { ringback } : {}) },
      };
    },
  );

  /** Uploaded sound files. Immutable by id (a replaced sound gets a new id), so cache forever. */
  app.get<{ Params: { id: string } }>(
    '/media/:id',
    {
      config: {
        doc: {
          summary: 'An uploaded sound file (hold music, ringtone, ringback)',
          access: 'public',
          tag: 'public',
          errors: ['404 not_found'],
        },
      },
    },
    async (request, reply) => {
      const asset = await readMediaAsset(db, request.params.id);
      if (!asset) return reply.code(404).send({ error: 'not_found' });
      return reply
        .header('content-type', asset.mimeType)
        .header('content-length', asset.sizeBytes)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(asset.data);
    },
  );
};
