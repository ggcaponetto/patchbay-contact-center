import type { AgentStatus, CallStatus, ServerMessage, TranscriptSegmentInput } from '@cc/shared';

export type Offer = {
  callId: string;
  queueKey: string;
  reason?: string;
  summary?: string;
  expiresAt: string;
};

type PresenceEntry = {
  userId: string;
  name: string;
  status: AgentStatus;
  callId: string | null;
};

export type DeskState = {
  connected: boolean;
  myStatus: AgentStatus;
  offer: Offer | null;
  agents: PresenceEntry[];
  /** Latest status per call id, as pushed by the server. */
  callStatus: Record<string, CallStatus>;
  /** Live transcript segments per call id. */
  transcripts: Record<string, TranscriptSegmentInput[]>;
  /** Bumped on every call.updated so lists know to refetch. */
  callsVersion: number;
};

export const initialState: DeskState = {
  connected: false,
  myStatus: 'away',
  offer: null,
  agents: [],
  callStatus: {},
  transcripts: {},
  callsVersion: 0,
};

export type DeskAction =
  | { type: 'socket'; connected: boolean }
  | { type: 'myStatus'; status: AgentStatus }
  | { type: 'server'; message: ServerMessage }
  | { type: 'offer.clear' };

export function reduce(state: DeskState, action: DeskAction): DeskState {
  switch (action.type) {
    case 'socket':
      return {
        ...state,
        connected: action.connected,
        agents: action.connected ? state.agents : [],
      };
    case 'myStatus':
      return { ...state, myStatus: action.status };
    case 'offer.clear':
      return { ...state, offer: null };
    case 'server':
      return applyServer(state, action.message);
  }
}

function applyServer(state: DeskState, m: ServerMessage): DeskState {
  switch (m.type) {
    case 'presence':
      return { ...state, agents: m.agents };
    case 'call.offer':
      return {
        ...state,
        offer: {
          callId: m.callId,
          queueKey: m.queueKey,
          expiresAt: m.expiresAt,
          ...(m.reason !== undefined ? { reason: m.reason } : {}),
          ...(m.summary !== undefined ? { summary: m.summary } : {}),
        },
      };
    case 'call.offer.cancelled':
      return state.offer?.callId === m.callId ? { ...state, offer: null } : state;
    case 'call.updated':
      return {
        ...state,
        callStatus: { ...state.callStatus, [m.callId]: m.status },
        callsVersion: state.callsVersion + 1,
        offer: m.status === 'ended' && state.offer?.callId === m.callId ? null : state.offer,
      };
    case 'transcript':
      return {
        ...state,
        transcripts: {
          ...state.transcripts,
          [m.callId]: [...(state.transcripts[m.callId] ?? []), m.segment],
        },
      };
  }
}

/** Seconds left on an offer, never negative. */
export const secondsLeft = (offer: Offer, now: number): number =>
  Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - now) / 1000));

export const statusLabel: Record<CallStatus, string> = {
  ringing: 'Ringing',
  ai: 'With AI',
  waiting_human: 'Waiting for agent',
  human: 'With agent',
  ended: 'Ended',
};

export const statusColor: Record<CallStatus, 'default' | 'info' | 'warning' | 'success'> = {
  ringing: 'warning',
  ai: 'info',
  waiting_human: 'warning',
  human: 'success',
  ended: 'default',
};

/** Hash-based navigation: `#/desk`, `#/calls/<id>` ... */
export type Route =
  | { page: 'desk' }
  | { page: 'dashboard' }
  | { page: 'history' }
  | { page: 'settings' }
  | { page: 'call'; id: string };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  switch (parts[0]) {
    case 'dashboard':
      return { page: 'dashboard' };
    case 'history':
      return { page: 'history' };
    case 'settings':
      return { page: 'settings' };
    case 'calls':
      return parts[1] ? { page: 'call', id: parts[1] } : { page: 'history' };
    default:
      return { page: 'desk' };
  }
}

export function formatDuration(startedAt: string, endedAt: string | null, now: number): string {
  const ms = (endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt);
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
