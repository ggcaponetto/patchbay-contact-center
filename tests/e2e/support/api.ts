/**
 * Thin HTTP helpers over the API for the e2e specs. Three surfaces:
 *
 * - {@link admin} / {@link desk}: what a signed-in actor can do (their cookie decides who).
 * - {@link createCall}: what the embedded button does — `POST /api/public/calls`.
 * - {@link playAi}: what the AI worker does against `/api/internal/*` with the shared
 *   secret. The `core` tier has no real agent, so specs "play" it: join, speak, escalate,
 *   end. The shapes are the same the worker sends (see apps/agent/src/api.ts).
 *
 * Types are kept minimal on purpose (only the fields the specs assert on).
 */
import type { TenantSettings, TranscriptSegmentInput } from '@cc/shared';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { API_ORIGIN, INTERNAL_SECRET } from '../../../playwright.config.ts';

/** Fails loudly with the response body when the API did not answer 2xx. */
async function json<T>(pending: Promise<APIResponse>): Promise<T> {
  const res = await pending;
  if (!res.ok()) throw new Error(`${res.url()} → ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/** A call as listed by `GET /api/desk/calls`. */
export type CallRow = {
  id: string;
  queueKey: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  aiSummary: string | null;
  heldAt: string | null;
  dispositionCode: string | null;
  tags: string[];
  recordingState: 'off' | 'on' | 'paused';
};

/** A call with its children as returned by `GET /api/desk/calls/:id`. */
export type CallDetail = CallRow & {
  participants: { kind: string; identity: string; leftAt: string | null }[];
  transcript: { speaker: string; text: string }[];
  events: { type: string; payload: Record<string, unknown> }[];
};

/** Supervisor-side administration (`/api/admin/*`). */
export function admin(request: APIRequestContext) {
  const base = `${API_ORIGIN}/api/admin`;
  return {
    tenant: () =>
      json<{ id: string; name: string; settings: TenantSettings }>(request.get(`${base}/tenant`)),
    updateSettings: (settings: Partial<TenantSettings>) =>
      json<unknown>(request.patch(`${base}/tenant/settings`, { data: settings })),
    createTenant: (name: string) =>
      json<{ id: string }>(request.post(`${base}/tenants`, { data: { name } })),
    members: () =>
      json<{ userId: string; email: string; role: string }[]>(request.get(`${base}/members`)),
    invite: (email: string, role: 'agent' | 'supervisor' = 'agent') =>
      json<unknown>(request.post(`${base}/invites`, { data: { email, role } })),
    queues: () =>
      json<
        {
          id: string;
          key: string;
          name: string;
          memberIds: string[];
          config: Record<string, unknown>;
        }[]
      >(request.get(`${base}/queues`)),
    deleteQueue: (id: string) =>
      json<{ ok: true; archived: boolean }>(request.delete(`${base}/queues/${id}`)),
    mediaAssets: () =>
      json<{ id: string; name: string; mimeType: string; url: string }[]>(
        request.get(`${base}/media-assets`),
      ),
    createQueue: (name: string) =>
      json<{ id: string; key: string }>(
        request.post(`${base}/queues`, { data: { key: name, name } }),
      ),
    setQueueMembers: (id: string, userIds: string[]) =>
      json<unknown>(request.put(`${base}/queues/${id}/members`, { data: { userIds } })),
    setQueueConfig: (id: string, config: Record<string, unknown>) =>
      json<unknown>(request.put(`${base}/queues/${id}/config`, { data: config })),
    skills: (userId: string) =>
      json<{ skill: string; proficiency: number }[]>(
        request.get(`${base}/members/${userId}/skills`),
      ),
    setSkills: (userId: string, skills: { skill: string; proficiency: number }[]) =>
      json<unknown>(request.put(`${base}/members/${userId}/skills`, { data: { skills } })),
    createKey: (label: string, allowedOrigins: string[] = []) =>
      json<{ id: string; publicKey: string }>(
        request.post(`${base}/embed-keys`, { data: { label, allowedOrigins } }),
      ),
    deleteKey: (id: string) => json<unknown>(request.delete(`${base}/embed-keys/${id}`)),
  };
}

/** What any member can read or do (`/api/desk/*`, `/api/me`). */
export function desk(request: APIRequestContext) {
  const base = `${API_ORIGIN}/api/desk`;
  return {
    me: () =>
      json<{
        user: { id: string; email: string };
        memberships: { tenantId: string; role: string }[];
      }>(request.get(`${API_ORIGIN}/api/me`)),
    calls: () => json<CallRow[]>(request.get(`${base}/calls`)),
    call: (id: string) => json<CallDetail>(request.get(`${base}/calls/${id}`)),
    /** Raw response, for asserting on status codes (403 for agents, 409 when over). */
    join: (id: string, mode: 'listen' | 'takeover') =>
      request.post(`${base}/calls/${id}/join`, { data: { mode } }),
    leave: (id: string, role: 'human' | 'supervisor') =>
      json<unknown>(request.post(`${base}/calls/${id}/leave`, { data: { role } })),
  };
}

/**
 * Starts a call the way the embedded button does. `origin` is what the browser would send
 * as `Origin`; the key's allow-list is checked against it.
 */
export async function createCall(
  request: APIRequestContext,
  embedKey: string,
  opts: { queue?: string; origin?: string; page?: string } = {},
) {
  return json<{ callId: string; roomName: string; token: string; url: string }>(
    request.post(`${API_ORIGIN}/api/public/calls`, {
      headers: { origin: opts.origin ?? 'https://customer.example' },
      data: {
        embedKey,
        queue: opts.queue ?? 'support',
        customerMeta: { page: opts.page ?? 'https://customer.example/pricing', userAgent: 'e2e' },
      },
    }),
  );
}

/** Plays the AI worker for one call over the internal API. */
export function playAi(request: APIRequestContext, callId: string) {
  const base = `${API_ORIGIN}/api/internal/calls/${callId}`;
  const headers = { 'x-internal-secret': INTERNAL_SECRET };
  const identity = `ai:${callId}`;
  const post = <T>(path: string, data: unknown) =>
    json<T>(request.post(`${base}${path}`, { headers, data }));
  return {
    identity,
    /** The worker joined the room: participant row + `ai.joined` event. */
    join: async () => {
      await post('/participants', { kind: 'ai', identity });
      await post('/events', { type: 'ai.joined', payload: {} });
    },
    /** One final transcript segment; `speaker` defaults to the AI itself. */
    say: (text: string, speaker: TranscriptSegmentInput['speaker'] = 'ai') =>
      post('/transcript', {
        speaker,
        identity: speaker === 'customer' ? `customer:${callId}` : identity,
        text,
      } satisfies TranscriptSegmentInput),
    event: (type: string, payload: Record<string, unknown> = {}) =>
      post('/events', { type, payload }),
    /**
     * The `escalateToHuman` tool: long-polls until an agent accepts or the ring gives up.
     * Not awaited by the caller until the desk has answered.
     */
    escalate: (
      reason = 'Caller asked for a person',
      summary = 'Wants to change a booking.',
      ringSec = 20,
    ) =>
      post<{ outcome: 'accepted' | 'nobody'; agentName?: string }>('/escalate', {
        reason,
        summary,
        ringSec,
      }),
    /** The worker's shutdown: summary then `ended`. */
    end: (summary?: string) =>
      post('/status', { status: 'ended', ...(summary ? { summary } : {}) }),
  };
}
