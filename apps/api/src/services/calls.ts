/**
 * Call persistence: the `call` row and its three child tables (participants,
 * transcript segments, events).
 *
 * These functions are deliberately dumb writers and readers; they do not know about
 * routing, LiveKit or the event hub. Who calls what:
 *
 * - `routes/public.ts`: `createCall`, `addParticipant`, `addEvent`, `setCallStatus`.
 * - `routes/internal.ts` (AI worker): `getCall`, `addTranscript`, `addEvent`,
 *   `addParticipant` / `markParticipantLeft`, `setSummary`, `setCallStatus`.
 * - `flow.ts`: `getCall`, `addEvent`, `addParticipant`, `markParticipantLeft`, `setCallStatus`.
 * - `routes/desk.ts`: `listCalls`, `callDetail`.
 *
 * @see apps/api/src/services/README.md
 * @packageDocumentation
 */
import type { CallStatus, ParticipantKind, TranscriptSegmentInput } from '@cc/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { call, callEvent, callParticipant, queue, transcriptSegment, user } from '../db/schema.ts';

/**
 * Inserts the call in status `ringing`. The caller chooses the id so it can derive the
 * room name and participant identities from it before the row exists.
 *
 * @returns The inserted row.
 */
export async function createCall(
  db: Db,
  input: {
    id: string;
    tenantId: string;
    queueId: string;
    roomName: string;
    customerMeta: Record<string, unknown>;
    /** Customer language (BCP 47), when the website told us. */
    language?: string;
    /** Routing priority (from the queue; higher first). */
    priority?: number;
  },
) {
  const [row] = await db
    .insert(call)
    .values({ status: 'ringing', ...input })
    .returning();
  return row!;
}

/** The call row, or `undefined`. Not tenant-scoped: callers check `tenantId` when needed. */
export async function getCall(db: Db, id: string) {
  const [row] = await db.select().from(call).where(eq(call.id, id));
  return row;
}

/**
 * Writes the status; `ended` also stamps `endedAt`. No transition validation: the
 * callers (`Flow`, internal status route) own the state machine.
 *
 * @returns The updated row, or `undefined` for an unknown id.
 */
export async function setCallStatus(db: Db, id: string, status: CallStatus) {
  const [row] = await db
    .update(call)
    .set(status === 'ended' ? { status, endedAt: new Date() } : { status })
    .where(eq(call.id, id))
    .returning();
  return row;
}

/** Stores the AI's end-of-call summary (shown in the desk call list). */
export async function setSummary(db: Db, id: string, aiSummary: string) {
  await db.update(call).set({ aiSummary }).where(eq(call.id, id));
}

/**
 * Records that a participant joined. `identity` is the LiveKit identity
 * (`customer:<callId>`, `ai:<callId>`, `human:<userId>`, `supervisor:<userId>`);
 * `userId` is set only for desk users.
 *
 * @returns The inserted row.
 */
export async function addParticipant(
  db: Db,
  input: { callId: string; kind: ParticipantKind; identity: string; userId?: string },
) {
  const [row] = await db
    .insert(callParticipant)
    .values({ id: randomUUID(), ...input })
    .returning();
  return row!;
}

/** Stamps `leftAt` on the open participant rows matching the identity (no-op if none). */
export async function markParticipantLeft(db: Db, callId: string, identity: string) {
  await db
    .update(callParticipant)
    .set({ leftAt: new Date() })
    .where(
      and(
        eq(callParticipant.callId, callId),
        eq(callParticipant.identity, identity),
        isNull(callParticipant.leftAt),
      ),
    );
}

/**
 * Appends a timeline event. `type` is a free-form dotted string; the ones written by the
 * API are `call.created`, `escalation.requested`, `offer.accepted`, `offer.nobody`,
 * `agent.joined`, `takeover.joined`, `listen.joined`, `human.left`, `supervisor.left`.
 * The AI worker adds its own through `POST /api/internal/calls/:id/events`.
 */
export async function addEvent(
  db: Db,
  callId: string,
  type: string,
  payload: Record<string, unknown> = {},
) {
  await db.insert(callEvent).values({ id: randomUUID(), callId, type, payload });
}

/**
 * Stores one transcript segment as reported by the AI worker.
 * @returns The inserted row.
 */
export async function addTranscript(db: Db, callId: string, seg: TranscriptSegmentInput) {
  const [row] = await db
    .insert(transcriptSegment)
    .values({
      id: randomUUID(),
      callId,
      speaker: seg.speaker,
      identity: seg.identity,
      text: seg.text,
      startMs: seg.startMs ?? null,
      endMs: seg.endMs ?? null,
    })
    .returning();
  return row!;
}

/** Calls of a tenant, newest first, with their queue key. */
export async function listCalls(db: Db, tenantId: string, limit = 50) {
  return db
    .select({
      id: call.id,
      status: call.status,
      queueKey: queue.key,
      channel: call.channel,
      priority: call.priority,
      language: call.language,
      requiredSkills: call.requiredSkills,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      aiSummary: call.aiSummary,
      heldAt: call.heldAt,
      dispositionCode: call.dispositionCode,
      tags: call.tags,
      customerMeta: call.customerMeta,
    })
    .from(call)
    .innerJoin(queue, eq(queue.id, call.queueId))
    .where(eq(call.tenantId, tenantId))
    .orderBy(desc(call.startedAt))
    .limit(limit);
}

/**
 * Marks the customer held (music on hold) or retrieved.
 * @returns The stored `heldAt` (`null` when retrieved or the call is unknown).
 */
export async function setHeld(db: Db, id: string, held: boolean) {
  const [row] = await db
    .update(call)
    .set({ heldAt: held ? new Date() : null })
    .where(eq(call.id, id))
    .returning({ heldAt: call.heldAt });
  return row?.heldAt ?? null;
}

/** Sets the wrap-up disposition code of a call. */
export async function setDisposition(db: Db, id: string, code: string) {
  await db.update(call).set({ dispositionCode: code }).where(eq(call.id, id));
}

/** Replaces the tag list of a call. */
export async function setTags(db: Db, id: string, tags: string[]) {
  await db.update(call).set({ tags }).where(eq(call.id, id));
}

/** Replaces the skill keys pinned on the call (what the AI tagged at escalation). */
export async function setRequiredSkills(db: Db, id: string, skills: string[]) {
  await db.update(call).set({ requiredSkills: skills }).where(eq(call.id, id));
}

/** Sets the call's language (BCP 47 tag, normally the base tag such as `de`). */
export async function setLanguage(db: Db, id: string, language: string) {
  await db.update(call).set({ language }).where(eq(call.id, id));
}

/** Remembers the accepting agent for last-agent (sticky) routing on this call. */
export async function setPreferredAgent(db: Db, id: string, userId: string) {
  await db.update(call).set({ preferredAgentId: userId }).where(eq(call.id, id));
}

/** Persists the recording state of a call together with the active egress id. */
export async function setRecording(
  db: Db,
  id: string,
  state: 'off' | 'on' | 'paused',
  egressId: string | null,
) {
  await db
    .update(call)
    .set({ recordingState: state, recordingEgressId: egressId })
    .where(eq(call.id, id));
}

/**
 * Full detail of one call: participants (with the desk user's `name` when the
 * participant is a signed-in human or supervisor), transcript and events in order.
 * Tenant-scoped: returns `undefined` when the call belongs to another tenant.
 */
export async function callDetail(db: Db, tenantId: string, id: string) {
  const row = await getCall(db, id);
  if (!row || row.tenantId !== tenantId) return undefined;
  const [[q], participants, transcript, events] = await Promise.all([
    db.select({ key: queue.key }).from(queue).where(eq(queue.id, row.queueId)),
    db
      .select({
        id: callParticipant.id,
        callId: callParticipant.callId,
        kind: callParticipant.kind,
        identity: callParticipant.identity,
        userId: callParticipant.userId,
        joinedAt: callParticipant.joinedAt,
        leftAt: callParticipant.leftAt,
        name: user.name,
      })
      .from(callParticipant)
      .leftJoin(user, eq(user.id, callParticipant.userId))
      .where(eq(callParticipant.callId, id)),
    db
      .select()
      .from(transcriptSegment)
      .where(eq(transcriptSegment.callId, id))
      .orderBy(transcriptSegment.createdAt),
    db.select().from(callEvent).where(eq(callEvent.callId, id)).orderBy(callEvent.at),
  ]);
  return { ...row, queueKey: q?.key ?? '', participants, transcript, events };
}
