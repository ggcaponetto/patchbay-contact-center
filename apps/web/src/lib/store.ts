/**
 * Pure state of the agent desk.
 *
 * Everything the desk learns over the websocket (`/api/ws`) is folded into a single
 * {@link DeskState} by {@link reduce}. The reducer has no side effects and no React
 * imports, which is why it is unit-tested in `store.test.ts` and why `useDeskSocket`
 * (in `hooks.ts`) can simply call `dispatch({ type: 'server', message })` for every
 * frame it receives.
 *
 * The file also hosts the small pure helpers that pages share: offer countdown, status
 * labels/colors, duration formatting and the hash-route parser (there is no router
 * library in this app).
 */
import type { AgentStatus, CallStatus, ServerMessage, TranscriptSegmentInput } from '@cc/shared';

/**
 * An incoming call currently ringing this agent (the `call.offer` server message
 * without its `type`). Shown as a dialog on the Desk page until it is accepted,
 * declined, cancelled by the server or `expiresAt` passes.
 */
export type Offer = {
  callId: string;
  queueKey: string;
  /** Why the AI escalated, if it did (e.g. "customer asks for a refund"). */
  reason?: string;
  /** AI-written summary of the conversation so far, if any. */
  summary?: string;
  /** ISO timestamp; the server moves on to the next agent when it passes. */
  expiresAt: string;
};

/** One agent in the `presence` broadcast. */
type PresenceEntry = {
  userId: string;
  name: string;
  status: AgentStatus;
  /** The call the agent is on, if any. */
  callId: string | null;
};

/** Everything the desk knows, derived from websocket traffic and local actions. */
export type DeskState = {
  /** True while the websocket is open. */
  connected: boolean;
  /** Our own availability as last chosen in the UI (optimistic, not echoed by the server). */
  myStatus: AgentStatus;
  /** The offer currently ringing us, if any. */
  offer: Offer | null;
  /** Who is online in this tenant (cleared when the socket drops). */
  agents: PresenceEntry[];
  /** Latest status per call id, as pushed by the server. */
  callStatus: Record<string, CallStatus>;
  /** Live transcript segments per call id. */
  transcripts: Record<string, TranscriptSegmentInput[]>;
  /** Bumped on every call.updated so lists know to refetch. */
  callsVersion: number;
};

/** State before the socket connects: away, no offer, nothing known. */
export const initialState: DeskState = {
  connected: false,
  myStatus: 'away',
  offer: null,
  agents: [],
  callStatus: {},
  transcripts: {},
  callsVersion: 0,
};

/**
 * Inputs of {@link reduce}.
 *
 * - `socket`: the websocket opened or closed.
 * - `myStatus`: the agent toggled Available/Away (the hook also sends it to the server).
 * - `server`: a frame from the API, see `ServerMessage` in `@cc/shared`.
 * - `offer.clear`: the UI is done with the offer dialog (accepted, declined or failed).
 */
export type DeskAction =
  | { type: 'socket'; connected: boolean }
  | { type: 'myStatus'; status: AgentStatus }
  | { type: 'server'; message: ServerMessage }
  | { type: 'offer.clear' };

/**
 * Desk reducer: returns a new state for an action, never mutating the old one.
 * A socket close wipes `agents` because presence is only meaningful while connected;
 * transcripts and call statuses are kept so a reconnect does not blank the call page.
 */
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

/** Applies one websocket frame. Exhaustive over `ServerMessage['type']`. */
function applyServer(state: DeskState, m: ServerMessage): DeskState {
  switch (m.type) {
    case 'presence':
      return { ...state, agents: m.agents };
    case 'call.offer':
      // Optional fields are only copied when present so the object stays comparable in
      // tests (`toEqual` treats `reason: undefined` and a missing key differently).
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
      // Only drop the dialog if it is about this very call; a stale cancel must not
      // hide a newer offer.
      return state.offer?.callId === m.callId ? { ...state, offer: null } : state;
    case 'call.updated':
      return {
        ...state,
        callStatus: { ...state.callStatus, [m.callId]: m.status },
        callsVersion: state.callsVersion + 1,
        // An offer for a call that just ended is pointless: close it.
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

/** Human-readable label for each call status (chip text). */
export const statusLabel: Record<CallStatus, string> = {
  ringing: 'Ringing',
  ai: 'With AI',
  waiting_human: 'Waiting for agent',
  human: 'With agent',
  ended: 'Ended',
};

/** MUI `Chip` color for each call status. */
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

/**
 * Parses `location.hash` into a {@link Route}. Unknown paths fall back to the desk and
 * `#/calls/` without an id falls back to the history list. Navigation is done by
 * assigning `location.hash`; `useRoute` (hooks.ts) re-renders on `hashchange`.
 */
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

/**
 * `m:ss` duration of a call. Live calls (`endedAt === null`) are measured against `now`
 * (pass the value of `useNow()` so the figure ticks); never negative.
 */
export function formatDuration(startedAt: string, endedAt: string | null, now: number): string {
  const ms = (endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt);
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
