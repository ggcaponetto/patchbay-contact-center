import type { TenantSettings } from '@cc/shared';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({ basePath: '/api/auth' });

export type Me = {
  user: { id: string; email: string; name: string };
  isAdmin: boolean;
  memberships: { tenantId: string; role: 'agent' | 'supervisor'; tenantName: string }[];
};

export type CallSummary = {
  id: string;
  status: 'ringing' | 'ai' | 'waiting_human' | 'human' | 'ended';
  queueKey: string;
  startedAt: string;
  endedAt: string | null;
  aiSummary: string | null;
  customerMeta: Record<string, unknown>;
};

export type CallDetail = CallSummary & {
  participants: {
    kind: string;
    identity: string;
    userId: string | null;
    joinedAt: string;
    leftAt: string | null;
  }[];
  transcript: { id: string; speaker: string; identity: string; text: string; createdAt: string }[];
  events: { id: string; type: string; payload: Record<string, unknown>; at: string }[];
};

export type Tenant = { id: string; name: string; slug: string; settings: TenantSettings };
export type Queue = { id: string; key: string; name: string; memberIds: string[] };
export type Member = { userId: string; name: string; email: string; role: 'agent' | 'supervisor' };
export type Invite = { id: string; email: string; role: string; acceptedAt: string | null };
export type EmbedKey = { id: string; label: string; publicKey: string; allowedOrigins: string[] };

/** The tenant every request is scoped to; set once after sign-in. */
let tenantId = '';
export const setTenant = (id: string) => {
  tenantId = id;
};

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
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

export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });
