import { z } from 'zod';

/** Who answers first when a customer calls. */
export const RoutingMode = z.enum(['ai-first', 'human-first']);
export type RoutingMode = z.infer<typeof RoutingMode>;

/** What the AI agent does once a human agent joined the room. */
export const HandoffBehavior = z.enum(['leave', 'listen']);
export type HandoffBehavior = z.infer<typeof HandoffBehavior>;

/** Per-tenant configuration, stored as JSON on the tenant row. */
export const TenantSettings = z.object({
  routingMode: RoutingMode.default('ai-first'),
  handoff: z.object({ aiBehavior: HandoffBehavior.default('leave') }).prefault({}),
  /** In human-first mode, how long to ring humans before falling back to the AI. */
  humanFirstTimeoutSec: z.number().int().min(5).max(300).default(30),
  /** How long a single agent's offer rings before moving to the next agent. */
  offerTimeoutSec: z.number().int().min(5).max(120).default(20),
  aiAgent: z
    .object({
      instructions: z.string().max(8000).default(''),
      greeting: z.string().max(500).default('Greet the caller and ask how you can help.'),
    })
    .prefault({}),
});
export type TenantSettings = z.infer<typeof TenantSettings>;
export const defaultTenantSettings = (): TenantSettings => TenantSettings.parse({});

export const CallStatus = z.enum(['ringing', 'ai', 'waiting_human', 'human', 'ended']);
export type CallStatus = z.infer<typeof CallStatus>;

export const ParticipantKind = z.enum(['customer', 'ai', 'human', 'supervisor', 'transcriber']);
export type ParticipantKind = z.infer<typeof ParticipantKind>;

/** Attributes set on LiveKit participants so every peer knows who is who. */
export const ParticipantAttributes = z.object({
  role: ParticipantKind,
  userId: z.string().optional(),
  displayName: z.string().optional(),
});
export type ParticipantAttributes = z.infer<typeof ParticipantAttributes>;

export const AgentStatus = z.enum(['available', 'busy', 'away']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const MembershipRole = z.enum(['agent', 'supervisor']);
export type MembershipRole = z.infer<typeof MembershipRole>;

/** Job metadata the API passes to the AI agent worker when dispatching it. */
export const DispatchMetadata = z.object({
  callId: z.string(),
  tenantId: z.string(),
  queueKey: z.string(),
  settings: TenantSettings,
  customerMeta: z.record(z.string(), z.unknown()).default({}),
});
export type DispatchMetadata = z.infer<typeof DispatchMetadata>;

export const TranscriptSegmentInput = z.object({
  speaker: ParticipantKind,
  identity: z.string(),
  text: z.string().min(1),
  startMs: z.number().int().nonnegative().optional(),
  endMs: z.number().int().nonnegative().optional(),
});
export type TranscriptSegmentInput = z.infer<typeof TranscriptSegmentInput>;

/** Messages from the API to a desk client over the websocket. */
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
  z.object({
    type: z.literal('presence'),
    agents: z.array(
      z.object({
        userId: z.string(),
        name: z.string(),
        status: AgentStatus,
        callId: z.string().nullable(),
      }),
    ),
  }),
  z.object({ type: z.literal('transcript'), callId: z.string(), segment: TranscriptSegmentInput }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Messages from a desk client to the API over the websocket. */
export const ClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('status'), status: AgentStatus }),
  z.object({ type: z.literal('offer.accept'), callId: z.string() }),
  z.object({ type: z.literal('offer.decline'), callId: z.string() }),
  z.object({ type: z.literal('subscribe'), callId: z.string() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Builds the LiveKit room name for a call. */
export const roomNameFor = (tenantId: string, callId: string): string => `cc-${tenantId}-${callId}`;
