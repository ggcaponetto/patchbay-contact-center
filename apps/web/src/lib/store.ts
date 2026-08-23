/**
 * Pure state of the agent desk.
 *
 * Everything the desk learns over the websocket (`/api/ws`) is folded into a single
 * {@link DeskState} by {@link reduce}. The reducer has no side effects and no React
 * imports, which is why it is unit-tested in `store.test.ts` and why `useDeskSocket`
 * (in `hooks.ts`) can simply call `dispatch({ type: 'server', message })` for every
 * frame it receives.
 *
 * The file also hosts the small pure helpers that pages share: offer countdown, state and
 * status translation keys/colors, duration formatting and the hash-route parser (there is no router
 * library in this app).
 */
import { LANGUAGE_NAMES } from '@cc/i18n';
import type {
  AgentPresence,
  AgentState,
  CallStatus,
  ServerMessage,
  TranscriptSegmentInput,
} from '@cc/shared';
import type { TFunction } from 'i18next';

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
  /** Skill keys the AI pinned on the call (`billing`, `lang:de`), when any. */
  requiredSkills?: string[];
  /** The caller's language (BCP 47), when the AI detected one. */
  language?: string;
  /** True once the call-pinned skills were dropped (`QueueConfig.relaxAfterSec`). */
  relaxed?: boolean;
};

/** Everything the desk knows, derived from websocket traffic and local actions. */
export type DeskState = {
  /** True while the websocket is open. */
  connected: boolean;
  /** Name of the supervisor who logged us out, once a `logout` frame arrived. */
  loggedOutBy: string | null;
  /** The offer currently ringing us, if any. */
  offer: Offer | null;
  /**
   * Who is online in this tenant with their state (cleared when the socket drops). Our
   * own entry is the source of truth for our state; the server echoes every change.
   */
  agents: AgentPresence[];
  /** Latest status per call id, as pushed by the server. */
  callStatus: Record<string, CallStatus>;
  /** Live transcript segments per call id. */
  transcripts: Record<string, TranscriptSegmentInput[]>;
  /** Bumped on every call.updated so lists know to refetch. */
  callsVersion: number;
  /**
   * Hold state per call id (`heldAt` ISO timestamp, `null` while not held), from the
   * `call.updated` frames that carry it. The Desk prefers this over the fetched detail
   * so the Hold / Retrieve button never flickers while a refetch is in flight.
   */
  held: Record<string, string | null>;
  /** Instant messages received this session, newest last (capped at 20). */
  messages: { from: { userId: string; name: string }; text: string; broadcast: boolean }[];
  /** Tenant-wide banner text; empty hides the banner. Pushed on connect and on change. */
  ticker: string;
};

/** State before the socket connects: no offer, nothing known. */
export const initialState: DeskState = {
  connected: false,
  loggedOutBy: null,
  offer: null,
  agents: [],
  callStatus: {},
  transcripts: {},
  callsVersion: 0,
  held: {},
  messages: [],
  ticker: '',
};

/**
 * Inputs of {@link reduce}.
 *
 * - `socket`: the websocket opened or closed.
 * - `server`: a frame from the API, see `ServerMessage` in `@cc/shared`.
 * - `offer.clear`: the UI is done with the offer dialog (accepted, declined or failed).
 */
export type DeskAction =
  | { type: 'socket'; connected: boolean }
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
    case 'logout':
      return { ...state, loggedOutBy: m.by, agents: [], offer: null };
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
          ...(m.requiredSkills !== undefined ? { requiredSkills: m.requiredSkills } : {}),
          ...(m.language !== undefined ? { language: m.language } : {}),
          ...(m.relaxed !== undefined ? { relaxed: m.relaxed } : {}),
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
        held: m.heldAt === undefined ? state.held : { ...state.held, [m.callId]: m.heldAt },
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
    case 'im':
      return {
        ...state,
        messages: [
          ...state.messages.slice(-19),
          { from: m.from, text: m.text, broadcast: m.broadcast },
        ],
      };
    case 'ticker':
      return { ...state, ticker: m.text };
  }
}

/** What {@link speakerLabel} needs to name the people on a call. */
export type SpeakerContext = {
  /** Stored participants of the call (`GET /desk/calls/:id`), with their display names. */
  participants?: { identity: string; userId: string | null; name: string | null }[] | undefined;
  /** Live presence (`state.agents`): names of colleagues currently online. */
  agents: AgentPresence[];
};

/**
 * Human-readable label of a transcript segment's speaker. `human:<userId>` and
 * `supervisor:<userId>` become "Ann · Agent" / "Sam · Supervisor" when the name is
 * known (stored participants first, then live presence) and just the role word
 * otherwise; `customer:<callId>` becomes "Customer 1a2b3c4d", `ai:*` "AI assistant" and
 * anything else shows the raw `speaker`.
 */
export function speakerLabel(
  identity: string,
  speaker: string,
  ctx: SpeakerContext,
  t: TFunction,
): string {
  const [kind, ...rest] = identity.split(':');
  const id = rest.join(':');
  const named = (role: 'speakers.agent' | 'speakers.supervisor') => {
    const name =
      ctx.participants?.find((p) => p.identity === identity && p.name)?.name ??
      ctx.participants?.find((p) => p.userId === id && p.name)?.name ??
      ctx.agents.find((a) => a.userId === id)?.name;
    return name ? `${name} · ${t(role)}` : t(role);
  };
  switch (kind) {
    case 'human':
      return named('speakers.agent');
    case 'supervisor':
      return named('speakers.supervisor');
    case 'customer':
      return t('speakers.customer', { id: id.slice(0, 8) });
    case 'ai':
      return t('speakers.ai');
    default:
      return speaker;
  }
}

/** Our own presence entry, or `undefined` while offline. */
export const myPresence = (state: DeskState, userId: string): AgentPresence | undefined =>
  state.agents.find((a) => a.userId === userId);

/** Translation key of an agent state's label (`t(stateKey(state))`, chips and toggles). */
export const stateKey = (state: AgentState): `states.${AgentState}` => `states.${state}`;

/** MUI `Chip` color for each agent state. */
export const stateColor: Record<AgentState, 'default' | 'info' | 'warning' | 'success'> = {
  ready: 'success',
  not_ready: 'default',
  busy: 'warning',
  acw: 'info',
};

/** `m:ss` since an ISO timestamp (time in state), never negative. */
export const formatSince = (since: string, now: number): string => formatDuration(since, null, now);

/** Seconds left on an offer, never negative. */
export const secondsLeft = (offer: Offer, now: number): number =>
  Math.max(0, Math.ceil((Date.parse(offer.expiresAt) - now) / 1000));

/** Translation key of a call status's label (`t(statusKey(status))`, chip text). */
export const statusKey = (status: CallStatus): `statuses.${CallStatus}` => `statuses.${status}`;

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
  | { page: 'wallboard' }
  | { page: 'history' }
  /** `tab` is the settings section (`#/settings/queues`), `undefined` for the first. */
  | { page: 'settings'; tab?: string }
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
    case 'wallboard':
      return { page: 'wallboard' };
    case 'history':
      return { page: 'history' };
    case 'settings':
      return parts[1] ? { page: 'settings', tab: parts[1] } : { page: 'settings' };
    case 'calls':
      return parts[1] ? { page: 'call', id: parts[1] } : { page: 'history' };
    default:
      return { page: 'desk' };
  }
}

/**
 * Label of a wrap-up code as configured in the tenant's dispositions (`billing/refund`
 * shows as `billing · Refund`), or the raw code when unknown / settings not loaded.
 */
export function dispositionLabel(
  code: string,
  dispositions: { code: string; label: string }[] | undefined,
): string {
  const d = dispositions?.find((x) => x.code === code);
  if (!d) return code;
  return code.includes('/') ? `${code.split('/')[0]} · ${d.label}` : d.label;
}

/**
 * Display label of a routing skill key. `lang:it` becomes "Language: Italiano" (the
 * native name for the desk's languages, the raw tag otherwise), a key of the tenant's
 * catalogue shows its label, anything else the raw key.
 */
export function skillLabel(
  key: string,
  catalogue: { key: string; label: string }[] | undefined,
  t: TFunction,
): string {
  if (key.startsWith('lang:'))
    return t('skills.language', { name: languageName(key.slice('lang:'.length)) });
  return catalogue?.find((s) => s.key === key)?.label ?? key;
}

/** Native name of a language tag for the desk's languages (`it` → "Italiano"), else the tag. */
export const languageName = (tag: string): string =>
  (LANGUAGE_NAMES as Record<string, string>)[tag] ?? tag;

/**
 * `m:ss` duration of a call. Live calls (`endedAt === null`) are measured against `now`
 * (pass the value of `useNow()` so the figure ticks); never negative.
 */
export function formatDuration(startedAt: string, endedAt: string | null, now: number): string {
  const ms = (endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt);
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
