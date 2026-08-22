/**
 * Shared contracts of the contact-center POC.
 *
 * Everything that crosses a process boundary (API ⇄ AI agent worker, API ⇄ web desk,
 * API ⇄ embed button) is described here as a zod schema. Each schema is exported twice
 * under the same name: the runtime validator (`const`) and the inferred TypeScript type
 * (`type`), so callers write `TenantSettings.parse(json)` and `const s: TenantSettings`.
 *
 * Zod (v4) is used instead of plain interfaces because the data really does arrive as
 * untrusted JSON: tenant settings come from the database, dispatch metadata travels
 * through a LiveKit job, websocket frames come from a browser. Parsing at the boundary
 * also applies the defaults declared below, which is how older rows keep working after a
 * new optional field is added.
 *
 * There is no build step: `@cc/shared` resolves straight to this source file.
 *
 * @see packages/shared/README.md for producer/consumer tables and the evolution rules.
 * @packageDocumentation
 */
import { z } from 'zod';

/**
 * Who answers first when a customer calls. Stored in {@link TenantSettings}, read by the
 * API when it creates a call.
 *
 * - `ai-first`: the customer token carries an agent dispatch, so the AI worker joins the
 *   room immediately and humans are only offered the call when the AI escalates.
 * - `human-first`: the API rings the queue's available human agents first and only
 *   dispatches the AI (via the AgentDispatch API) when nobody picks up within
 *   {@link TenantSettings.humanFirstTimeoutSec}.
 */
export const RoutingMode = z.enum(['ai-first', 'human-first']);
/** Inferred type of {@link RoutingMode}. */
export type RoutingMode = z.infer<typeof RoutingMode>;

/**
 * What the AI agent does once a human agent joined the room. Applied by the agent worker
 * (`apps/agent/src/main.ts`, `onHumanJoined`).
 *
 * - `leave`: the AI closes its voice session, re-labels its participant as `transcriber`
 *   and keeps transcribing both the customer and the human so the desk transcript
 *   continues. The AI never speaks again on that call.
 * - `listen`: the AI mutes its audio output but keeps its session (and therefore its
 *   conversation history) alive, transcribing the customer through the session and the
 *   human through an extra transcriber.
 */
export const HandoffBehavior = z.enum(['leave', 'listen']);
/** Inferred type of {@link HandoffBehavior}. */
export type HandoffBehavior = z.infer<typeof HandoffBehavior>;

/**
 * Per-tenant configuration, stored as JSON on the tenant row.
 *
 * Produced by the web desk settings page (supervisors), validated and persisted by the
 * API, and shipped to the AI worker inside {@link DispatchMetadata} so the agent never
 * needs a database connection. Every field has a default, so `TenantSettings.parse({})`
 * is a valid configuration (see {@link defaultTenantSettings}).
 *
 * @example
 * ```ts
 * const settings = TenantSettings.parse({ routingMode: 'human-first' });
 * settings.handoff.aiBehavior; // 'leave' (default)
 * ```
 */
export const TenantSettings = z.object({
  /** Who answers first; see {@link RoutingMode}. Default `ai-first`. */
  routingMode: RoutingMode.default('ai-first'),
  /** Handoff policy; `aiBehavior` defaults to `leave`. See {@link HandoffBehavior}. */
  handoff: z.object({ aiBehavior: HandoffBehavior.default('leave') }).prefault({}),
  /** In human-first mode, how long to ring humans before falling back to the AI. */
  humanFirstTimeoutSec: z.number().int().min(5).max(300).default(30),
  /** How long a single agent's offer rings before moving to the next agent. */
  offerTimeoutSec: z.number().int().min(5).max(120).default(20),
  /**
   * After-call work: seconds an agent stays in `acw` after a call before becoming
   * `ready` automatically. `0` disables wrap-up (straight back to `ready`).
   */
  acwSec: z.number().int().min(0).max(600).default(30),
  /**
   * Disposition (wrap-up) codes agents pick after a call. A `/` in the code makes a
   * two-level hierarchy (`billing/refund` shows as "Refund" under "billing").
   */
  dispositions: z
    .array(z.object({ code: z.string().min(1).max(60), label: z.string().min(1).max(80) }))
    .max(200)
    .default([]),
  /** When true, wrap-up cannot be finished before a disposition was set. */
  dispositionRequired: z.boolean().default(false),
  /** Desk reminder after a customer was on hold this long; `0` disables it. */
  holdReminderSec: z.number().int().min(0).max(600).default(60),
  /** Auto-answer: offers are accepted automatically after a zip tone at the desk. */
  autoAnswer: z.boolean().default(false),
  /** Reason (aux) codes an agent can pick when going `not_ready`; `RONA` is added by the API. */
  notReadyReasons: z
    .array(z.string().min(1).max(40))
    .max(20)
    .default(['Break', 'Lunch', 'Meeting', 'Training']),
  /** Prompt material for the AI agent; both strings are appended to the built-in base prompt. */
  aiAgent: z
    .object({
      /** Tenant-specific instructions (company facts, tone, policies). Max 8000 chars. */
      instructions: z.string().max(8000).default(''),
      /** Instruction used to generate the very first AI utterance of a call. */
      greeting: z.string().max(500).default('Greet the caller and ask how you can help.'),
    })
    .prefault({}),
});
/** Inferred type of {@link TenantSettings}. */
export type TenantSettings = z.infer<typeof TenantSettings>;
/** A fresh settings object with every default applied (used for new tenants and tests). */
export const defaultTenantSettings = (): TenantSettings => TenantSettings.parse({});

/**
 * Lifecycle of a call, as stored on the call row and broadcast to desks through the
 * `call.updated` {@link ServerMessage}. Owned by the API; the agent only ever sends
 * `ended` (via `POST /api/internal/calls/:id/status`).
 *
 * - `ringing`: the row was just created and no routing decision has been made yet (the
 *   API moves on to `ai` or `waiting_human` within the same request).
 * - `ai`: the AI agent is handling the call.
 * - `waiting_human`: human agents are being rung, either because the AI escalated or
 *   because the tenant is human-first. The customer is on hold or still talking to the AI.
 * - `human`: a human agent accepted and joined the room.
 * - `ended`: terminal. The LiveKit room is deleted and the summary (if any) is stored.
 */
export const CallStatus = z.enum(['ringing', 'ai', 'waiting_human', 'human', 'ended']);
/** Inferred type of {@link CallStatus}. */
export type CallStatus = z.infer<typeof CallStatus>;

/**
 * Kinds of participants in a call. Used as the `role` attribute on LiveKit participants
 * ({@link ParticipantAttributes}), as the `speaker` of a {@link TranscriptSegmentInput}
 * and as the `kind` column of the participants table.
 *
 * - `customer`: the caller, identity `customer:<callId>`, joins from the embed button.
 * - `ai`: the AI agent worker, identity `ai:<callId>`, while it is speaking.
 * - `human`: a desk agent who accepted the call (or a supervisor taking over),
 *   identity `human:<userId>`.
 * - `supervisor`: a desk user listening in without publishing audio, identity
 *   `supervisor:<userId>`.
 * - `transcriber`: the same AI worker after a `leave` handoff; it no longer speaks and
 *   only produces transcript segments for the humans.
 * - `media`: the media worker playing music on hold, identity `media:<callId>`.
 */
export const ParticipantKind = z.enum([
  'customer',
  'ai',
  'human',
  'supervisor',
  'transcriber',
  'media',
]);
/** Inferred type of {@link ParticipantKind}. */
export type ParticipantKind = z.infer<typeof ParticipantKind>;

/**
 * Attributes set on LiveKit participants so every peer knows who is who.
 *
 * The API bakes them into access tokens; the agent sets them on itself with
 * `localParticipant.setAttributes`. The agent reads `role` of remote participants to
 * detect a human joining and to pick which tracks to transcribe.
 */
export const ParticipantAttributes = z.object({
  /** See {@link ParticipantKind}. */
  role: ParticipantKind,
  /** Desk user id; only present for `human` and `supervisor`. */
  userId: z.string().optional(),
  /** Name shown in the desk UI; only present for `human` and `supervisor`. */
  displayName: z.string().optional(),
});
/** Inferred type of {@link ParticipantAttributes}. */
export type ParticipantAttributes = z.infer<typeof ParticipantAttributes>;

/**
 * State of a desk user (classic contact-center agent states). Only `ready` agents are
 * offered calls. `logged_out` is implicit: a user with no desk socket has no presence.
 *
 * - `ready`: taking calls.
 * - `not_ready`: logged in, not taking calls; carries a reason (aux) code such as
 *   `Break`, or `RONA` when set by the API after an unanswered ring.
 * - `busy`: on a call (set by the API when an offer is accepted or a call is joined).
 * - `acw`: after-call work / wrap-up, timed by {@link TenantSettings.acwSec}; the agent
 *   can extend it or finish early.
 */
export const AgentState = z.enum(['ready', 'not_ready', 'busy', 'acw']);
/** Inferred type of {@link AgentState}. */
export type AgentState = z.infer<typeof AgentState>;

/** The reason code the API uses when an agent did not answer a ring (RONA). */
export const RONA_REASON = 'RONA';

/**
 * Body of `POST /api/desk/state` (and of the supervisor's force-state route): the states
 * a person can ask for. `busy` and `acw` are set by the API, never requested.
 */
export const AgentStateRequest = z.object({
  state: z.enum(['ready', 'not_ready']),
  /** Reason code for `not_ready`; ignored for `ready`. */
  reason: z.string().min(1).max(40).optional(),
});
/** Inferred type of {@link AgentStateRequest}. */
export type AgentStateRequest = z.infer<typeof AgentStateRequest>;

/** One agent in the `presence` {@link ServerMessage}. */
export const AgentPresence = z.object({
  userId: z.string(),
  name: z.string(),
  state: AgentState,
  /** Reason code while `not_ready`, else `null`. */
  reason: z.string().nullable(),
  /** ISO time the current state was entered (time-in-state timers). */
  since: z.string(),
  /** Call the agent is on (`busy`) or just left (`acw`), else `null`. */
  callId: z.string().nullable(),
  /** ISO time wrap-up ends automatically while `acw`, else `null`. */
  acwUntil: z.string().nullable(),
});
/** Inferred type of {@link AgentPresence}. */
export type AgentPresence = z.infer<typeof AgentPresence>;

/**
 * Role of a user inside a tenant (membership row). A role is a fixed set of
 * {@link Permission}s ({@link ROLE_PERMISSIONS}); API keys carry an explicit set instead.
 *
 * - `agent`: can take calls.
 * - `supervisor`: can additionally edit {@link TenantSettings}, manage queues, members,
 *   API keys, and listen in on / take over calls.
 */
export const MembershipRole = z.enum(['agent', 'supervisor']);
/** Inferred type of {@link MembershipRole}. */
export type MembershipRole = z.infer<typeof MembershipRole>;

/**
 * What a route requires. Every API operation names exactly one permission; a signed-in
 * user has the permissions of their role in the selected tenant, an API key the ones it
 * was created with.
 *
 * - `calls:read`: list calls, call detail, who is online, desk settings.
 * - `calls:answer`: accept / decline / leave calls, change one's own state and wrap-up.
 * - `calls:supervise`: listen in, take over, force agent states, log agents out.
 * - `tenant:read`: tenant settings, members, invites, queues, embed keys, API keys (read).
 * - `tenant:write`: change all of the above.
 * - `api-keys:manage`: create and revoke API keys.
 */
export const Permission = z.enum([
  'calls:read',
  'calls:answer',
  'calls:supervise',
  'tenant:read',
  'tenant:write',
  'api-keys:manage',
]);
/** Inferred type of {@link Permission}. */
export type Permission = z.infer<typeof Permission>;

/** The permissions of each {@link MembershipRole}. */
export const ROLE_PERMISSIONS: Record<MembershipRole, readonly Permission[]> = {
  agent: ['calls:read', 'calls:answer'],
  supervisor: [
    'calls:read',
    'calls:answer',
    'calls:supervise',
    'tenant:read',
    'tenant:write',
    'api-keys:manage',
  ],
};

/** Body of `POST /api/admin/api-keys`. */
export const ApiKeyRequest = z.object({
  name: z.string().min(1).max(80),
  permissions: z.array(Permission).min(1),
});
/** Inferred type of {@link ApiKeyRequest}. */
export type ApiKeyRequest = z.infer<typeof ApiKeyRequest>;

/**
 * Job metadata the API passes to the AI agent worker when dispatching it.
 *
 * Serialized with `JSON.stringify` into either the customer's token room configuration
 * (ai-first) or an explicit AgentDispatch call (human-first fallback); the worker parses
 * it back from `ctx.job.metadata`. It carries everything the agent needs so the worker
 * stays stateless and has no database access.
 */
export const DispatchMetadata = z.object({
  /** Call id, also the suffix of the `ai:<callId>` / `customer:<callId>` identities. */
  callId: z.string(),
  /** Tenant that owns the call. */
  tenantId: z.string(),
  /** Key of the queue the call came in on (for example `support`). */
  queueKey: z.string(),
  /** Snapshot of the tenant settings at dispatch time. */
  settings: TenantSettings,
  /** Free-form data the embed button attached to the call (page URL, user id, ...). */
  customerMeta: z.record(z.string(), z.unknown()).default({}),
});
/** Inferred type of {@link DispatchMetadata}. */
export type DispatchMetadata = z.infer<typeof DispatchMetadata>;

/**
 * A command from the API to the media worker (`apps/media`), carried on the
 * cross-instance bus as `{ kind: 'media', command }`. The worker joins the call's room
 * with the given token and plays the hold-music loop until told to stop (or the room
 * closes under it).
 */
export const MediaCommand = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('moh.start'),
    callId: z.string(),
    roomName: z.string(),
    token: z.string(),
    url: z.string(),
  }),
  z.object({ action: z.literal('moh.stop'), callId: z.string() }),
]);
/** Inferred type of {@link MediaCommand}. */
export type MediaCommand = z.infer<typeof MediaCommand>;

/**
 * One line of transcript. Produced by the agent worker (`POST /api/internal/calls/:id/transcript`),
 * stored by the API and fanned out to subscribed desks inside the `transcript`
 * {@link ServerMessage}.
 */
export const TranscriptSegmentInput = z.object({
  /** Who said it; see {@link ParticipantKind}. */
  speaker: ParticipantKind,
  /** LiveKit identity of the speaker. */
  identity: z.string(),
  /** Final transcript text; interim results are never sent. */
  text: z.string().min(1),
  /** Optional start offset in milliseconds from the start of the call (not set by the current agent). */
  startMs: z.number().int().nonnegative().optional(),
  /** Optional end offset in milliseconds from the start of the call (not set by the current agent). */
  endMs: z.number().int().nonnegative().optional(),
});
/** Inferred type of {@link TranscriptSegmentInput}. */
export type TranscriptSegmentInput = z.infer<typeof TranscriptSegmentInput>;

/**
 * Messages from the API to a desk client over the websocket, discriminated on `type`.
 * Parsed by the web desk store; the agent never sees them.
 *
 * - `call.offer`: this agent is being rung for a call. `reason` and `summary` are present
 *   when the AI escalated; `expiresAt` (ISO date) is when the offer moves on to the next
 *   agent. The desk accepts over REST (it needs a LiveKit token back) or declines with
 *   the `offer.decline` {@link ClientMessage}.
 * - `call.offer.cancelled`: the offer above is no longer for this agent (timed out,
 *   someone else took it or the call ended).
 * - `call.updated`: the call's {@link CallStatus} changed.
 * - `presence`: full list of the tenant's online agents ({@link AgentPresence}); sent
 *   whenever anyone's state changes.
 * - `transcript`: a new {@link TranscriptSegmentInput} for a call the desk subscribed to.
 */
export const ServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('call.offer'),
    callId: z.string(),
    queueKey: z.string(),
    reason: z.string().optional(),
    summary: z.string().optional(),
    expiresAt: z.string(),
  }),
  z.object({ type: z.literal('call.offer.cancelled'), callId: z.string() }),
  z.object({ type: z.literal('call.updated'), callId: z.string(), status: CallStatus }),
  z.object({ type: z.literal('presence'), agents: z.array(AgentPresence) }),
  /** You were forced out by a supervisor; the desk signs out and stops reconnecting. */
  z.object({ type: z.literal('logout'), by: z.string() }),
  z.object({ type: z.literal('transcript'), callId: z.string(), segment: TranscriptSegmentInput }),
]);
/** Inferred type of {@link ServerMessage}. */
export type ServerMessage = z.infer<typeof ServerMessage>;

/**
 * Messages from a desk client to the API over the websocket, discriminated on `type`.
 *
 * - `offer.decline`: pass on the `call.offer` I was sent; the API rings the next agent.
 * - `subscribe`: start receiving `transcript` messages for `callId` (used when viewing
 *   or joining a call).
 *
 * State changes (`ready`, `not_ready`, wrap-up) and accepting an offer are REST calls
 * (`/api/desk/state`, `/api/desk/calls/:id/accept`): every operation has a public API,
 * and accepting returns the LiveKit token.
 */
export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('offer.decline'), callId: z.string() }),
  z.object({ type: z.literal('subscribe'), callId: z.string() }),
]);
/** Inferred type of {@link ClientMessage}. */
export type ClientMessage = z.infer<typeof ClientMessage>;

/**
 * Builds the LiveKit room name for a call. Used by the API when creating the call; the
 * agent receives the room from LiveKit and never computes it.
 *
 * @param tenantId - Owning tenant id.
 * @param callId - Call id.
 * @returns `cc-<tenantId>-<callId>`.
 * @example
 * ```ts
 * roomNameFor('t1', 'c1'); // 'cc-t1-c1'
 * ```
 */
export const roomNameFor = (tenantId: string, callId: string): string => `cc-${tenantId}-${callId}`;
