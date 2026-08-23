/**
 * The LiveKit side of the call button as a React hook: creates the call through the
 * public API, joins the room, publishes the microphone, plays remote audio, loops the
 * ringback while waiting and drives the {@link CallState} machine of `state.ts`.
 * `CallButton.tsx` only renders what comes out of here.
 */
import { type RemoteParticipant, type RemoteTrack, Room, RoomEvent, Track } from 'livekit-client';
import { type RefObject, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { type CallState, MISSING_KEY, reduce } from './state.ts';

/** What a call needs; read at click time, so attribute changes apply to the next call. */
export type CallOptions = {
  /** Public embed key (`pk_…`); a click without it fails with {@link MISSING_KEY}. */
  embedKey: string;
  /** Queue key to ring. */
  queue: string;
  /** Origin of the API (no path). */
  api: string;
  /** The customer's language (BCP 47), sent for language routing; `undefined` omits it. */
  language: string | undefined;
};

/** What {@link useCall} returns. */
export type Call = {
  /** Current machine state. */
  state: CallState;
  /** "Now" in ms epoch, refreshed every second during a call so the duration ticks. */
  now: number;
  /** Click on the call button. */
  start: () => Promise<void>;
  /** Click on the hang-up button. */
  hangUp: () => Promise<void>;
  /** Click on the mute / unmute button. */
  toggleMute: () => Promise<void>;
  /** Put on the `<div>` that holds the `<audio>` elements created by `track.attach()`. */
  audioRef: RefObject<HTMLDivElement | null>;
};

/** API response of `POST /api/public/calls`, the parts the button uses. */
type CreatedCall = { token: string; url: string; sounds?: { ringback?: string } };

/** Resolves the API's `/api/public/media/…` ringback path against the API origin. */
const ringbackSrc = (url: string, api: string) => (url.startsWith('/') ? `${api}${url}` : url);

/**
 * Runs one call at a time for the element that renders it. The room is left when the
 * component unmounts (the element was removed from the page mid-call).
 */
export function useCall(options: CallOptions): Call {
  const [state, dispatch] = useReducer(reduce, { kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const [ringbackUrl, setRingbackUrl] = useState<string | undefined>(undefined);
  const opts = useRef(options);
  opts.current = options;
  const stateRef = useRef(state);
  stateRef.current = state;
  const room = useRef<Room | undefined>(undefined);
  const audioRef = useRef<HTMLDivElement | null>(null);

  /**
   * A remote participant appeared or changed attributes. The `role` attribute is set
   * by the API (token) or by the AI agent on itself, possibly after it joined, which
   * is why `ParticipantAttributesChanged` also routes here.
   */
  const onPeer = useCallback((p: RemoteParticipant) => {
    const role = p.attributes['role'];
    if (role) dispatch({ type: 'peer_joined', role, name: p.name || undefined });
  }, []);

  /** Leaves the room and moves to `ended` (`hangup` by the customer, else `disconnected`). */
  const end = useCallback(async (byUser: boolean) => {
    const current = room.current;
    room.current = undefined;
    audioRef.current?.replaceChildren();
    await current?.disconnect();
    dispatch({ type: byUser ? 'hangup' : 'disconnected' });
  }, []);

  /**
   * Creates the call, joins the room and enables the microphone. Any failure (HTTP
   * error, refused origin, mic permission) lands in the `error` state and tears the
   * room down.
   */
  const start = useCallback(async () => {
    // A click while connecting / in a call is ignored by the reducer: skip the network too.
    if (reduce(stateRef.current, { type: 'click' }) === stateRef.current) return;
    dispatch({ type: 'click' });
    const { embedKey, queue, api, language } = opts.current;
    try {
      if (!embedKey) throw new Error(MISSING_KEY);
      const res = await fetch(`${api}/api/public/calls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          embedKey,
          queue,
          language,
          customerMeta: { page: location.href, userAgent: navigator.userAgent },
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        throw new Error(body.message ?? body.error ?? res.statusText);
      }
      const { token, url, sounds } = (await res.json()) as CreatedCall;
      setRingbackUrl(sounds?.ringback);
      const r = new Room();
      room.current = r;
      r.on(RoomEvent.ParticipantConnected, onPeer)
        .on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
          if (!p.isLocal) onPeer(p as RemoteParticipant);
        })
        .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub, participant?) => {
          // A whispering supervisor talks to the agent only: never play them here.
          if (participant?.attributes['monitor'] === 'whisper') return;
          if (track.kind === Track.Kind.Audio) audioRef.current?.append(track.attach());
        })
        .on(RoomEvent.Disconnected, () => void end(false));
      await r.connect(url, token);
      await r.localParticipant.setMicrophoneEnabled(true);
      const at = Date.now();
      setNow(at);
      dispatch({ type: 'connected', at });
      // The AI is dispatched with the customer's token and is often already in the room
      // by the time `connect` resolves, so no `ParticipantConnected` event fires for it.
      // Events that did fire before `connected` were ignored by the reducer (state was
      // still `connecting`), so re-announce every present peer now.
      r.remoteParticipants.forEach(onPeer);
    } catch (err) {
      dispatch({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      await end(false);
    }
  }, [onPeer, end]);

  const hangUp = useCallback(() => end(true), [end]);

  /** The reducer decides whether mute applies; the microphone follows the next state. */
  const toggleMute = useCallback(async () => {
    const next = reduce(stateRef.current, { type: 'toggle_mute' });
    if (next.kind !== 'in_call') return;
    dispatch({ type: 'toggle_mute' });
    await room.current?.localParticipant.setMicrophoneEnabled(!next.muted);
  }, []);

  // The duration ticks once a second while in the room.
  const active = state.kind === 'waiting' || state.kind === 'in_call';
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  // Loop the ringback while `waiting` (the click allowed audio); stop it in any other state.
  const waiting = state.kind === 'waiting';
  useEffect(() => {
    if (!waiting || !ringbackUrl) return;
    const el = new Audio(ringbackSrc(ringbackUrl, opts.current.api));
    el.loop = true;
    el.volume = 0.5;
    el.play().catch(() => undefined);
    return () => {
      el.pause();
      el.removeAttribute('src');
    };
  }, [waiting, ringbackUrl]);

  // Unmount (element removed from the page): leave the room.
  useEffect(
    () => () => {
      void room.current?.disconnect().catch(() => undefined);
      room.current = undefined;
    },
    [],
  );

  return { state, now, start, hangUp, toggleMute, audioRef };
}
