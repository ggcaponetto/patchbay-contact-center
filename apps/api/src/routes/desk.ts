/**
 * `/api/desk`: what an agent or supervisor does with calls from the web desk.
 *
 * Listing and detail are read-only views; `accept`, `decline`, `join` and `leave` are
 * the REST half of the ringing protocol (the push half is the websocket in `ws.ts`).
 * Accepting is REST rather than a socket message because the answer is a LiveKit token.
 * Agent states (`/state`, wrap-up, the supervisor's force-state) are REST too: every
 * operation of the desk has a public API.
 *
 * Authorization by permission (see `Permission` in `@cc/shared`): reads need
 * `calls:read`, taking and leaving calls and one's own state `calls:answer`, listen-in /
 * take-over / force-state `calls:supervise`. The tenant is the one selected by
 * `x-tenant-id` (or the first membership; an API key's own). Every call id is checked
 * against the caller's tenant before use.
 *
 * @see apps/api/src/routes/README.md
 * @packageDocumentation
 */
import { AgentPresence, AgentStateRequest } from '@cc/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.ts';
import type { Flow } from '../flow.ts';
import type { Access, RouteDoc } from '../openapi.ts';
import type { Guards } from '../server.ts';
import { addEvent, callDetail, listCalls, setDisposition, setTags } from '../services/calls.ts';
import { getTenant, listQueues } from '../services/tenants.ts';
import type { DeskSockets } from '../ws.ts';
import { parseBody } from './util.ts';

/** Plugin options for {@link deskRoutes}. `guards` come from `server.ts`. */
export type DeskOpts = { db: Db; guards: Guards; flow: Flow; sockets: DeskSockets };

type P = { Params: { id: string } };

/** Body of the supervisor's force-state route: an agent state request, or log the agent out. */
const ForceStateBody = z.union([AgentStateRequest, z.object({ state: z.literal('logged_out') })]);
const JoinBody = z.object({
  mode: z.enum(['listen', 'whisper', 'barge', 'takeover', 'intercept']),
});
const NoteBody = z.object({ text: z.string().min(1).max(2000) });
const TagsBody = z.object({ tags: z.array(z.string().min(1).max(40)).max(20) });
const TransferBody = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('queue'), id: z.string().min(1) }),
    z.object({ kind: z.literal('user'), id: z.string().min(1) }),
  ]),
});
const ConsultBody = z.object({ targetUserId: z.string().min(1) });
const ConsultCompleteBody = z.object({
  mode: z.enum(['transfer', 'conference', 'drop']),
  dropUserId: z.string().optional(),
});
const DispositionBody = z.object({
  code: z.string().min(1).max(60),
  note: z.string().max(2000).optional(),
});
const LeaveBody = z.object({ role: z.enum(['human', 'supervisor']).default('human') });
const TokenResponse = z.object({ token: z.string(), url: z.string() });
const doc = (
  summary: string,
  access: Access,
  extra: Partial<RouteDoc> = {},
): { doc: RouteDoc } => ({
  doc: { summary, access, tag: 'desk', ...extra },
});

/**
 * Endpoints for signed-in agents and supervisors of a tenant.
 *
 * Errors: 401 `unauthenticated`, 403 `no_tenant` / `forbidden`, 404 `not_found`,
 * 409 `not_ringing_you` (accept) / `call_over` (accept, join) / `offline`, `on_call`,
 * `not_in_acw` (states).
 */
export const deskRoutes: FastifyPluginAsync<DeskOpts> = async (
  app,
  { db, guards: { authorize }, flow, sockets },
) => {
  const read = authorize('calls:read');
  const answer = authorize('calls:answer');
  const supervise = authorize('calls:supervise');

  /** The tenant settings every member needs at the desk (reason codes, wrap-up length). */
  app.get(
    '/settings',
    {
      preHandler: read,
      config: doc(
        'Tenant settings every member needs (reason codes, wrap-up length)',
        'calls:read',
      ),
    },
    async (request) => {
      const tenant = await getTenant(db, request.ctx.tenantId);
      return {
        notReadyReasons: tenant?.settings.notReadyReasons ?? [],
        acwSec: tenant?.settings.acwSec ?? 0,
        dispositions: tenant?.settings.dispositions ?? [],
        dispositionRequired: tenant?.settings.dispositionRequired ?? false,
        holdReminderSec: tenant?.settings.holdReminderSec ?? 0,
        monitorNotify: tenant?.settings.monitorNotify ?? true,
        autoAnswer: tenant?.settings.autoAnswer ?? false,
        queues: (await listQueues(db, request.ctx.tenantId)).map((q) => ({
          id: q.id,
          key: q.key,
          name: q.name,
        })),
      };
    },
  );

  /** Everyone online in the tenant with their state (the `presence` message, on demand). */
  app.get(
    '/agents',
    {
      preHandler: read,
      config: doc('Everyone online in the tenant with their state', 'calls:read', {
        response: z.array(AgentPresence),
      }),
    },
    async (request) => flow.routing.snapshot(request.ctx.tenantId),
  );

  /** My own presence entry, or `undefined` when I have no desk socket open. */
  const mine = async (userId: string, tenantId: string) =>
    (await flow.routing.snapshot(tenantId)).find((a) => a.userId === userId);

  /** Go `ready` or `not_ready` (with a reason code). 409 `offline` / `on_call`. */
  app.post(
    '/state',
    {
      preHandler: answer,
      config: doc('Go ready or not ready (with a reason code)', 'calls:answer', {
        body: AgentStateRequest,
        response: AgentPresence,
        errors: ['409 offline / on_call'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(AgentStateRequest, request.body, reply);
      if (!body) return undefined;
      const err = await flow.routing.setState(request.ctx.user.id, body.state, body.reason);
      if (err) return reply.code(409).send({ error: err });
      return mine(request.ctx.user.id, request.ctx.tenantId);
    },
  );

  /** Add the tenant's `acwSec` to my running wrap-up. 409 `not_in_acw`. */
  app.post(
    '/acw/extend',
    {
      preHandler: answer,
      config: doc('Add the wrap-up time to my running wrap-up', 'calls:answer', {
        response: AgentPresence,
        errors: ['409 not_in_acw'],
      }),
    },
    async (request, reply) => {
      const tenant = await getTenant(db, request.ctx.tenantId);
      const ok = await flow.routing.extendAcw(request.ctx.user.id, tenant?.settings.acwSec ?? 30);
      if (!ok) return reply.code(409).send({ error: 'not_in_acw' });
      return mine(request.ctx.user.id, request.ctx.tenantId);
    },
  );

  /** Finish wrap-up early: straight to `ready`. */
  app.post(
    '/acw/done',
    {
      preHandler: answer,
      config: doc('Finish wrap-up early', 'calls:answer', {
        response: AgentPresence,
        errors: ['409 not_in_acw / disposition_required'],
      }),
    },
    async (request, reply) => {
      const me = await mine(request.ctx.user.id, request.ctx.tenantId);
      if (me?.state !== 'acw') return reply.code(409).send({ error: 'not_in_acw' });
      // Mandatory wrap-up codes: the call worked on must carry a disposition first.
      const tenant = await getTenant(db, request.ctx.tenantId);
      if (tenant?.settings.dispositionRequired && me.callId) {
        const worked = await callDetail(db, request.ctx.tenantId, me.callId);
        if (worked && !worked.dispositionCode) {
          return reply.code(409).send({ error: 'disposition_required' });
        }
      }
      await flow.routing.setState(request.ctx.user.id, 'ready');
      return mine(request.ctx.user.id, request.ctx.tenantId);
    },
  );

  /**
   * Supervisors: force an online agent of the tenant `ready` / `not_ready` (which also
   * ends a wrap-up), or log them out (their desks are disconnected with a `logout` message).
   * 404 when the agent is not online in this tenant, 409 `on_call`.
   */
  app.post<{ Params: { userId: string } }>(
    '/agents/:userId/state',
    {
      preHandler: supervise,
      config: doc('Force an agent ready / not ready, or log them out', 'calls:supervise', {
        body: ForceStateBody,
        errors: ['404 not_found', '409 on_call'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(ForceStateBody, request.body, reply);
      if (!body) return undefined;
      const { userId } = request.params;
      const target = await flow.routing.presenceOf(userId);
      if (!target || target.tenantId !== request.ctx.tenantId) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (body.state === 'logged_out') {
        // Their sockets may be on any instance: the bus closes them everywhere.
        await sockets.bus.publish({ kind: 'logout', userId, by: request.ctx.user.name });
        await flow.routing.disconnect(userId);
        return { ok: true };
      }
      const err = await flow.routing.setState(userId, body.state, body.reason);
      if (err) return reply.code(409).send({ error: err });
      return mine(userId, request.ctx.tenantId);
    },
  );

  /** Latest 50 calls of the tenant, newest first. */
  app.get(
    '/calls',
    { preHandler: read, config: doc('Latest 50 calls of the tenant, newest first', 'calls:read') },
    async (request) => listCalls(db, request.ctx.tenantId),
  );

  /** One call with participants, transcript and events. */
  app.get<P>(
    '/calls/:id',
    {
      preHandler: read,
      config: doc('One call with participants, transcript and events', 'calls:read', {
        errors: ['404 not_found'],
      }),
    },
    async (request, reply) => {
      const detail = await callDetail(db, request.ctx.tenantId, request.params.id);
      return detail ?? reply.code(404).send({ error: 'not_found' });
    },
  );

  /**
   * Accept the offer currently ringing this agent; returns the LiveKit token to join.
   * `routing.accept` is the gate: only the agent being rung right now gets through.
   */
  app.post<P>(
    '/calls/:id/accept',
    {
      preHandler: answer,
      config: doc('Accept the offer ringing me; returns the LiveKit token', 'calls:answer', {
        response: TokenResponse,
        errors: ['404 not_found', '409 not_ringing_you / call_over'],
      }),
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await callDetail(db, request.ctx.tenantId, id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const offer = await flow.routing.accept(id, request.ctx.user.id);
      if (!offer) {
        return reply.code(409).send({ error: 'not_ringing_you' });
      }
      const joined = await flow.join(id, request.ctx.user, 'agent');
      if (!joined) return reply.code(409).send({ error: 'call_over' });
      // A blind transfer's acceptor also takes the customer off hold.
      if (offer.retrieveOnAccept) await flow.unhold(id);
      return joined;
    },
  );

  /** Same as the `offer.decline` socket message; always `{ ok: true }`. */
  app.post<P>(
    '/calls/:id/decline',
    { preHandler: answer, config: doc('Decline the offer ringing me', 'calls:answer') },
    async (request) => {
      await flow.routing.decline(request.params.id, request.ctx.user.id);
      return { ok: true };
    },
  );

  /** Supervisors: listen in silently or take the call over. Returns a LiveKit token. */
  app.post<P>(
    '/calls/:id/join',
    {
      preHandler: supervise,
      config: doc(
        'Monitor (listen / whisper / barge) or take the call (takeover / intercept)',
        'calls:supervise',
        { body: JoinBody, response: TokenResponse, errors: ['404 not_found', '409 call_over'] },
      ),
    },
    async (request, reply) => {
      const body = parseBody(JoinBody, request.body, reply);
      if (!body) return undefined;
      const { id } = request.params;
      if (!(await callDetail(db, request.ctx.tenantId, id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const joined = await flow.join(id, request.ctx.user, body.mode);
      return joined ?? reply.code(409).send({ error: 'call_over' });
    },
  );

  /** The desk left the room. A human agent leaving ends the call. */
  app.post<P>(
    '/calls/:id/leave',
    {
      preHandler: answer,
      config: doc('Leave the room; a human leaving ends the call', 'calls:answer', {
        body: LeaveBody,
        errors: ['404 not_found'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(LeaveBody, request.body ?? {}, reply);
      if (!body) return undefined;
      const { id } = request.params;
      if (!(await callDetail(db, request.ctx.tenantId, id))) {
        return reply.code(404).send({ error: 'not_found' });
      }
      await flow.leave(id, request.ctx.user, body.role);
      return { ok: true };
    },
  );

  /** Loads the call of this tenant or answers 404; helper for the annotation routes. */
  const withCall = async (id: string, tenantId: string, reply: Parameters<typeof parseBody>[2]) => {
    const detail = await callDetail(db, tenantId, id);
    if (!detail) reply.code(404).send({ error: 'not_found' });
    return detail;
  };

  /**
   * Puts the customer on hold: the media worker joins the room and plays music (only the
   * customer keeps listening — the desk mutes itself and stops subscribing), `heldAt` is
   * stamped for the hold timer. Retrieve reverses it.
   */
  app.post<P>(
    '/calls/:id/hold',
    {
      preHandler: answer,
      config: doc('Put the customer on hold (music plays)', 'calls:answer', {
        errors: ['404 not_found', '409 not_live / already_held'],
      }),
    },
    async (request, reply) => {
      const detail = await withCall(request.params.id, request.ctx.tenantId, reply);
      if (!detail) return undefined;
      if (detail.status === 'ended') return reply.code(409).send({ error: 'not_live' });
      if (detail.heldAt) return reply.code(409).send({ error: 'already_held' });
      await flow.hold(detail.id);
      return { ok: true };
    },
  );

  /** Takes the customer off hold; the music stops. */
  app.post<P>(
    '/calls/:id/retrieve',
    {
      preHandler: answer,
      config: doc('Retrieve the held customer (music stops)', 'calls:answer', {
        errors: ['404 not_found', '409 not_held'],
      }),
    },
    async (request, reply) => {
      const detail = await withCall(request.params.id, request.ctx.tenantId, reply);
      if (!detail) return undefined;
      if (!detail.heldAt) return reply.code(409).send({ error: 'not_held' });
      await flow.unhold(detail.id);
      return { ok: true };
    },
  );

  /** Body of `POST /calls/:id/recording`. */
  const RecordingBody = z.object({
    action: z.enum(['start', 'pause', 'resume', 'stop']),
  });

  /**
   * Controls call recording via LiveKit Egress: `start` → `on`, `pause` / `resume`
   * toggle a PCI-safe gap between segments, `stop` → `off`. Needs `RECORDING_S3_*`
   * (or `RECORDING_STUB=true` in dev) on the API, otherwise 409 `recording_unavailable`.
   */
  app.post<P>(
    '/calls/:id/recording',
    {
      preHandler: answer,
      config: doc('Control call recording (start / pause / resume / stop)', 'calls:answer', {
        body: RecordingBody,
        errors: ['404 not_found', '409 not_live / invalid_state / recording_unavailable'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(RecordingBody, request.body, reply);
      if (!body) return undefined;
      const detail = await withCall(request.params.id, request.ctx.tenantId, reply);
      if (!detail) return undefined;
      const err = await flow.recording(detail.id, body.action, request.ctx.user);
      if (err) return reply.code(409).send({ error: err });
      return { ok: true };
    },
  );

  /**
   * Blind (cold) transfer to a queue or a single user. The caller's desk closes its
   * panel locally afterwards — the server already marked them gone.
   */
  app.post<P>(
    '/calls/:id/transfer',
    {
      preHandler: answer,
      config: doc('Blind-transfer the call to a queue or a user', 'calls:answer', {
        body: TransferBody,
        errors: ['404 not_found', '409 not_live / empty_target'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(TransferBody, request.body, reply);
      if (!body) return undefined;
      if (!(await withCall(request.params.id, request.ctx.tenantId, reply))) return undefined;
      const err = await flow.transfer(request.params.id, request.ctx.user, body.target);
      if (err) return reply.code(409).send({ error: err });
      return { ok: true };
    },
  );

  /** Starts a consultation: customer on hold with music, the colleague is rung. */
  app.post<P>(
    '/calls/:id/consult',
    {
      preHandler: answer,
      config: doc('Consult a colleague (customer goes on hold)', 'calls:answer', {
        body: ConsultBody,
        errors: ['404 not_found', '409 not_live'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(ConsultBody, request.body, reply);
      if (!body) return undefined;
      if (!(await withCall(request.params.id, request.ctx.tenantId, reply))) return undefined;
      const err = await flow.consult(request.params.id, request.ctx.user, body.targetUserId);
      if (err) return reply.code(409).send({ error: err });
      return { ok: true };
    },
  );

  /** Ends the consultation: hand over, conference everyone, or drop the consultant. */
  app.post<P>(
    '/calls/:id/consult/complete',
    {
      preHandler: answer,
      config: doc('Complete the consultation (transfer / conference / drop)', 'calls:answer', {
        body: ConsultCompleteBody,
        errors: ['404 not_found', '409 not_live / no_consultant'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(ConsultCompleteBody, request.body, reply);
      if (!body) return undefined;
      if (!(await withCall(request.params.id, request.ctx.tenantId, reply))) return undefined;
      const err = await flow.consultComplete(
        request.params.id,
        request.ctx.user,
        body.mode,
        body.dropUserId,
      );
      if (err) return reply.code(409).send({ error: err });
      return { ok: true };
    },
  );

  /** A free-form note on the call's timeline, visible on the call page. */
  app.post<P>(
    '/calls/:id/note',
    {
      preHandler: answer,
      config: doc('Add a note to the call', 'calls:answer', {
        body: NoteBody,
        errors: ['404 not_found'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(NoteBody, request.body, reply);
      if (!body) return undefined;
      if (!(await withCall(request.params.id, request.ctx.tenantId, reply))) return undefined;
      await addEvent(db, request.params.id, 'note', {
        text: body.text,
        userId: request.ctx.user.id,
        name: request.ctx.user.name,
      });
      return { ok: true };
    },
  );

  /** Replaces the call's tags (categorization during or after the call). */
  app.post<P>(
    '/calls/:id/tags',
    {
      preHandler: answer,
      config: doc('Replace the tags of the call', 'calls:answer', {
        body: TagsBody,
        errors: ['404 not_found'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(TagsBody, request.body, reply);
      if (!body) return undefined;
      if (!(await withCall(request.params.id, request.ctx.tenantId, reply))) return undefined;
      await setTags(db, request.params.id, body.tags);
      return { ok: true };
    },
  );

  /**
   * Sets the wrap-up disposition. The code must be one of the tenant's
   * `dispositions`; with `dispositionRequired`, `POST /acw/done` refuses until it is set.
   */
  app.post<P>(
    '/calls/:id/disposition',
    {
      preHandler: answer,
      config: doc('Set the wrap-up disposition code of the call', 'calls:answer', {
        body: DispositionBody,
        errors: ['400 unknown_code', '404 not_found'],
      }),
    },
    async (request, reply) => {
      const body = parseBody(DispositionBody, request.body, reply);
      if (!body) return undefined;
      if (!(await withCall(request.params.id, request.ctx.tenantId, reply))) return undefined;
      const tenant = await getTenant(db, request.ctx.tenantId);
      if (!tenant?.settings.dispositions.some((d) => d.code === body.code)) {
        return reply.code(400).send({ error: 'unknown_code' });
      }
      await setDisposition(db, request.params.id, body.code);
      await addEvent(db, request.params.id, 'disposition', {
        code: body.code,
        userId: request.ctx.user.id,
        ...(body.note ? { note: body.note } : {}),
      });
      return { ok: true };
    },
  );
};
