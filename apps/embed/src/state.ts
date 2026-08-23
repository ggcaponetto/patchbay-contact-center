/**
 * Pure state machine of the call button. No DOM, no LiveKit, no i18n: the `useCall` hook
 * feeds it {@link CallEvent}s and `CallButton.tsx` renders whatever {@link CallState}
 * comes back, which keeps the tricky ordering questions (who joined when, what a click
 * means in each state) unit-testable in `state.test.ts`. Everything shown to the
 * customer is returned as translation keys ({@link statusKey}, {@link PeerInfo}) and
 * translated at render time.
 */

/**
 * Pure UI state for the call button; the custom element renders from it.
 *
 * - `idle`: nothing happening, the call button is shown.
 * - `connecting`: `POST /api/public/calls` and `Room.connect` in progress.
 * - `waiting`: in the room, nobody to talk to yet (`since` = connect time, ms epoch).
 * - `in_call`: an AI or human peer is present; `with` says who (translated at render).
 * - `ended`: hung up or disconnected; a click starts a new call.
 * - `error`: something failed (mic denied, bad key, origin refused); a click retries.
 */
export type CallState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'waiting'; since: number }
  | { kind: 'in_call'; since: number; with: PeerInfo; muted: boolean }
  | { kind: 'ended' }
  | { kind: 'error'; message: string };

/**
 * Inputs of {@link reduce}. `peer_joined` is also dispatched for attribute changes and
 * for participants already present at connect time, so it may repeat for the same peer.
 */
export type CallEvent =
  | { type: 'click' }
  | { type: 'connected'; at: number }
  | { type: 'peer_joined'; role: string; name: string | undefined }
  | { type: 'peer_left'; role: string }
  | { type: 'toggle_mute' }
  | { type: 'hangup' }
  | { type: 'disconnected' }
  | { type: 'error'; message: string }
  | { type: 'reset' };

/** Whoever the customer is talking to: `t('peers.ai')` or `t('peers.agent', { name })`. */
export type PeerInfo = { kind: 'ai' } | { kind: 'human'; name: string };

/** {@link PeerInfo} for a remote participant's `role` attribute and display name. */
export const peerInfo = (role: string, name: string | undefined): PeerInfo =>
  role === 'human' ? { kind: 'human', name: name ?? '' } : { kind: 'ai' };

/**
 * Sentinel `error` message for a click without a `key` attribute; the renderer shows
 * it as the translated `missingKey` text (API messages are shown verbatim).
 */
export const MISSING_KEY = 'missing_key';

/**
 * Transition function. Events that make no sense in the current state return the same
 * object (callers may rely on identity to skip re-rendering).
 */
export function reduce(state: CallState, event: CallEvent): CallState {
  switch (event.type) {
    case 'click':
      return state.kind === 'idle' || state.kind === 'ended' || state.kind === 'error'
        ? { kind: 'connecting' }
        : state;
    case 'connected':
      return state.kind === 'connecting' ? { kind: 'waiting', since: event.at } : state;
    case 'peer_joined':
      // Transcribers and other customers are not conversation partners.
      if (event.role !== 'ai' && event.role !== 'human') return state;
      if (state.kind === 'waiting') {
        return {
          kind: 'in_call',
          since: state.since,
          with: peerInfo(event.role, event.name),
          muted: false,
        };
      }
      if (state.kind === 'in_call') {
        // A human taking over from the AI replaces the label; the AI joining later does not.
        return event.role === 'human'
          ? { ...state, with: peerInfo(event.role, event.name) }
          : state;
      }
      return state;
    case 'peer_left':
      // Ignored on purpose: the room's `Disconnected` event is what ends a call. A human
      // leaving ends the call server-side, the AI leaving after a handoff must not.
      return state;
    case 'toggle_mute':
      return state.kind === 'in_call' ? { ...state, muted: !state.muted } : state;
    case 'hangup':
    case 'disconnected':
      // Do not clobber an error message with "Call ended" when cleanup disconnects.
      return state.kind === 'idle' || state.kind === 'error' ? state : { kind: 'ended' };
    case 'error':
      return { kind: 'error', message: event.message };
    case 'reset':
      return { kind: 'idle' };
  }
}

/**
 * What to show under the button: the translation key of `locales/*.json` plus the
 * values it interpolates. `key: null` means nothing (idle).
 */
export type Status =
  | { key: null }
  | { key: 'connecting' | 'pleaseHold' | 'ended' }
  | { key: 'inCall'; peer: PeerInfo; duration: string }
  | { key: 'couldNotStart'; message: string };

/** {@link Status} for each state; `now` (ms epoch) feeds the running call duration. */
export function statusKey(state: CallState, now: number): Status {
  switch (state.kind) {
    case 'idle':
      return { key: null };
    case 'connecting':
      return { key: 'connecting' };
    case 'waiting':
      return { key: 'pleaseHold' };
    case 'in_call':
      return { key: 'inCall', peer: state.with, duration: formatDuration(now - state.since) };
    case 'ended':
      return { key: 'ended' };
    case 'error':
      return { key: 'couldNotStart', message: state.message };
  }
}

/** `m:ss` for a duration in milliseconds; negative input yields `0:00`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
