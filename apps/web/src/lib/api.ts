/**
 * HTTP layer of the agent desk.
 *
 * Three things live here:
 *
 * - {@link authClient}: the Better Auth React client (Google sign-in, session hook).
 * - The DTO types returned by the API (`Me`, `CallSummary`, `CallDetail`, ...). They are
 *   hand-written mirrors of what `apps/api` returns; the shared contracts in `@cc/shared`
 *   only cover the pieces that cross more than one boundary.
 * - {@link api} and its verb helpers ({@link post}, {@link patch}, {@link put},
 *   {@link del}): a thin `fetch` wrapper that prefixes `/api`, sends JSON, includes the
 *   session cookie and adds the `x-tenant-id` header so the API knows which contact
 *   center the request is about — plus, in dev mode, `x-dev-user` from `devUser.ts` so
 *   each browser tab can be a different person.
 *
 * In development `/api` is proxied to the API by Vite (see `vite.config.ts`), so every
 * request is same-origin and the auth cookie is first-party.
 */
import type { MediaAsset, TenantSettings } from '@cc/shared';
import { createAuthClient } from 'better-auth/react';
import { devHeaders } from './devUser.ts';

/**
 * `fetch` with this tab's dev-user header added (read per request, so a switch in the
 * "Signed in as …" menu takes effect on the next call). Used by the Better Auth client,
 * which does its own requests (`/api/auth/get-session`).
 */
export const fetchAsDevUser = (input: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(devHeaders())) headers.set(k, v);
  return fetch(input, { ...init, headers });
};

/**
 * Better Auth browser client. Used for `useSession()` (the gate in `App.tsx`),
 * `signIn.social({ provider: 'google' })` and `signOut()`. With `DEV_USER_EMAIL` set on the
 * API, `/api/auth/get-session` returns the dev user (the tab's own, via `x-dev-user`), so
 * no Google round-trip happens.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  fetchOptions: { customFetchImpl: fetchAsDevUser },
});

/** Response of `GET /api/me`: the signed-in user and the tenants they belong to. */
export type Me = {
  user: { id: string; email: string; name: string };
  /** Platform admin (can create tenants); not used by the UI yet. */
  isAdmin: boolean;
  /** One entry per contact center; the first one is selected by default. */
  memberships: { tenantId: string; role: 'agent' | 'supervisor'; tenantName: string }[];
  /** The API runs with the dev-auth bypass: the app bar offers "switch user". */
  devMode?: boolean;
};

/** `GET /api/desk/settings`: the tenant settings the Desk page needs (any member). */
export type DeskSettings = {
  notReadyReasons: string[];
  acwSec: number;
  dispositions: { code: string; label: string }[];
  dispositionRequired: boolean;
  holdReminderSec: number;
  monitorNotify: boolean;
  ticker: string;
  autoAnswer: boolean;
  /** Ringtone URL played while an offer rings (`TenantSettings.sounds.ringtone`), if set. */
  ringtone?: string;
  queues: { id: string; key: string; name: string }[];
};

/** `GET /api/desk/stats`: live tenant statistics and threshold alerts. */
export type TenantStats = {
  waiting: number;
  longestWaitSec: number;
  active: number;
  longestCallSec: number;
  agents: { ready: number; notReady: number; busy: number; acw: number };
  today: { calls: number; answered: number; avgHandleSec: number };
  alerts: string[];
};

/** One row of `GET /api/desk/calls` (History and Dashboard lists). */
export type CallSummary = {
  id: string;
  status: 'ringing' | 'ai' | 'waiting_human' | 'human' | 'ended';
  queueKey: string;
  startedAt: string;
  endedAt: string | null;
  /** Written by the AI agent at the end of the call (or on escalation). */
  aiSummary: string | null;
  /** When the customer was put on hold, `null` while not held. */
  heldAt: string | null;
  /** Wrap-up code picked by the handling agent, or `null`. */
  dispositionCode: string | null;
  /** Recording state machine: `off` → `on` ⇄ `paused` → `off`. */
  recordingState: 'off' | 'on' | 'paused';
  /** Free-form categorization tags. */
  tags: string[];
  /** How the contact came in (`voice` for now). */
  channel: string;
  /** Routing priority; higher first. */
  priority: number;
  /** Customer language (BCP 47), when known. */
  language: string | null;
  /** Free-form data sent by the embed button, e.g. `{ page, userAgent }`. */
  customerMeta: Record<string, unknown>;
};

/** Response of `GET /api/desk/calls/:id`: a summary plus everything stored for the call. */
export type CallDetail = CallSummary & {
  participants: {
    kind: string;
    identity: string;
    userId: string | null;
    joinedAt: string;
    leftAt: string | null;
  }[];
  /** Persisted transcript rows, oldest first. */
  transcript: { id: string; speaker: string; identity: string; text: string; createdAt: string }[];
  /** Audit trail (`call.created`, `handoff.requested`, ...), oldest first. */
  events: { id: string; type: string; payload: Record<string, unknown>; at: string }[];
};

/** `GET /api/admin/tenant`. */
export type Tenant = { id: string; name: string; slug: string; settings: TenantSettings };
/** `GET /api/admin/queues`; `memberIds` are the agents rung for this queue. */
export type Queue = {
  id: string;
  key: string;
  name: string;
  memberIds: string[];
  /** Routing configuration (`QueueConfig` in `@cc/shared`), `{}` for the defaults. */
  config: Record<string, unknown>;
};

/** One skill with proficiency 1-5, `GET /api/admin/members/:userId/skills`. */
export type Skill = { skill: string; proficiency: number };
/** `GET /api/admin/members`. */
export type Member = { userId: string; name: string; email: string; role: 'agent' | 'supervisor' };
/** `GET /api/admin/invites`; `acceptedAt` is null while the invite is pending. */
export type Invite = { id: string; email: string; role: string; acceptedAt: string | null };
/**
 * `GET /api/admin/embed-keys`. `publicKey` (`pk_…`) goes into the website snippet; an
 * empty `allowedOrigins` means any website may use the key.
 */
export type EmbedKey = { id: string; label: string; publicKey: string; allowedOrigins: string[] };
/** `GET /api/admin/api-keys`; `POST` additionally returns `secret` once. */
export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/**
 * Uploads a sound file as a media asset (`POST /api/admin/media-assets`, base64 JSON) and
 * returns the stored asset with its public URL.
 */
export async function uploadMediaAsset(file: File): Promise<MediaAsset> {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
  return post<MediaAsset>('/admin/media-assets', {
    name: file.name,
    mimeType: file.type || 'audio/wav',
    data,
  });
}

/** The tenant every request is scoped to; set once after sign-in. */
let tenantId = '';
/**
 * Selects the tenant for all subsequent {@link api} calls. Called by the `Shell` in
 * `App.tsx` whenever the membership (tenant selector) changes.
 */
export const setTenant = (id: string) => {
  tenantId = id;
};

/** Thrown by {@link api} for non-2xx responses; `message` is the API's `error` code. */
class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * JSON `fetch` against the API.
 *
 * - Prefixes `/api` (so pass `/desk/calls`, not `/api/desk/calls`).
 * - Sends `content-type: application/json`, the session cookie, `x-tenant-id` and (dev
 *   mode, when this tab picked someone) `x-dev-user`.
 * - Parses the JSON body; throws `ApiError` on a non-OK status using the `error`
 *   field of the body when present (the API answers `{ error: 'not_found' }` etc.).
 *
 * @typeParam T the expected response shape (not validated at runtime).
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      // Fastify rejects a JSON content-type without a body (e.g. DELETE), so only
      // declare it when there is one.
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
      ...devHeaders(),
      ...(init.headers ?? {}),
    },
    credentials: 'include',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

/** `POST` with a JSON body (defaults to `{}` so endpoints without a body still parse). */
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
/** `PATCH` with a JSON body. */
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
/** `PUT` with a JSON body. */
export const put = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
/** `DELETE` without a body. */
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });
