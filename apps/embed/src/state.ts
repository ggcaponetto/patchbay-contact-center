/** Pure UI state for the call button; the custom element renders from it. */
export type CallState =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'waiting'; since: number }
  | { kind: 'in_call'; since: number; with: string; muted: boolean }
  | { kind: 'ended' }
  | { kind: 'error'; message: string };

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

/** Display name for whoever the customer is talking to. */
export const peerLabel = (role: string, name: string | undefined): string =>
  role === 'human' ? `Agent ${name ?? ''}`.trim() : 'AI assistant';

export function reduce(state: CallState, event: CallEvent): CallState {
  switch (event.type) {
    case 'click':
      return state.kind === 'idle' || state.kind === 'ended' || state.kind === 'error'
        ? { kind: 'connecting' }
        : state;
    case 'connected':
      return state.kind === 'connecting' ? { kind: 'waiting', since: event.at } : state;
    case 'peer_joined':
      if (event.role !== 'ai' && event.role !== 'human') return state;
      if (state.kind === 'waiting') {
        return {
          kind: 'in_call',
          since: state.since,
          with: peerLabel(event.role, event.name),
          muted: false,
        };
      }
      if (state.kind === 'in_call') {
        // A human taking over from the AI replaces the label; the AI joining later does not.
        return event.role === 'human'
          ? { ...state, with: peerLabel(event.role, event.name) }
          : state;
      }
      return state;
    case 'peer_left':
      return state;
    case 'toggle_mute':
      return state.kind === 'in_call' ? { ...state, muted: !state.muted } : state;
    case 'hangup':
    case 'disconnected':
      return state.kind === 'idle' || state.kind === 'error' ? state : { kind: 'ended' };
    case 'error':
      return { kind: 'error', message: event.message };
    case 'reset':
      return { kind: 'idle' };
  }
}

/** Text shown under the button for each state. */
export function statusText(state: CallState, now: number): string {
  switch (state.kind) {
    case 'idle':
      return '';
    case 'connecting':
      return 'Connecting…';
    case 'waiting':
      return 'Please hold, connecting you…';
    case 'in_call':
      return `${state.with} · ${formatDuration(now - state.since)}`;
    case 'ended':
      return 'Call ended. Thanks for calling!';
    case 'error':
      return `Could not start the call: ${state.message}`;
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
