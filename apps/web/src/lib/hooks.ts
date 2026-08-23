/**
 * React hooks of the agent desk.
 *
 * - {@link useDeskSocket}: owns the websocket to `/api/ws` and the reduced `DeskState`
 *   (see `store.ts`); every page gets its return value as the `desk` prop.
 * - {@link useLiveRoom}: wraps a `livekit-client` `Room` (connect, microphone, remote
 *   audio playback, peer list, mute, the local side of hold) for the in-call view.
 * - {@link useRoute}: current hash route.
 * - {@link useNow}: a one-second ticker for countdowns and durations.
 */
import type { ClientMessage, ServerMessage } from '@cc/shared';
import { Room, RoomEvent, Track } from 'livekit-client';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { devUser } from './devUser.ts';
import { initialState, parseRoute, reduce } from './store.ts';

/**
 * Desk websocket: reconnects on close (unless a supervisor logged us out), exposes the
 * reduced state and a sender. Agent states are set over REST (`/api/desk/state`); the
 * server echoes them in the `presence` frame, so `state.agents` is the truth.
 *
 * Opens `ws(s)://<host>/api/ws?tenantId=…` (proxied to the API in dev), plus `&as=<email>`
 * when this tab runs as another dev user (`devUser.ts`; browsers cannot set headers on a
 * websocket upgrade, so the API reads it from the query). Every frame is a
 * `ServerMessage` and goes straight into {@link reduce}. If the socket closes for any
 * reason (API restart, network blip) it is reopened after two seconds, forever, until
 * the component unmounts or `tenantId` changes. The server treats a fresh connection as
 * a fresh presence (`not_ready`), and the desk shows exactly that.
 *
 * @param tenantId the tenant to connect for; `undefined` keeps the socket closed.
 * @returns `state` (`DeskState`), the raw `dispatch` and `send` for `ClientMessage`s.
 */
export function useDeskSocket(tenantId: string | undefined) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const socketRef = useRef<WebSocket | null>(null);
  // Messages sent before the socket is open (a call page loaded directly subscribes
  // right away); flushed on `open`, so nothing is lost and nothing throws.
  const pendingRef = useRef<ClientMessage[]>([]);

  useEffect(() => {
    if (!tenantId) return;
    // `closed` distinguishes a deliberate close (cleanup) from a dropped connection:
    // only the latter schedules a reconnect.
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const as = devUser();
      const ws = new WebSocket(
        `${proto}://${location.host}/api/ws?tenantId=${tenantId}` +
          (as ? `&as=${encodeURIComponent(as)}` : ''),
      );
      socketRef.current = ws;
      ws.onopen = () => {
        dispatch({ type: 'socket', connected: true });
        for (const m of pendingRef.current.splice(0)) ws.send(JSON.stringify(m));
      };
      ws.onmessage = (e) => {
        const message = JSON.parse(String(e.data)) as ServerMessage;
        if (message.type === 'logout') closed = true; // forced out: do not reconnect
        dispatch({ type: 'server', message });
      };
      ws.onclose = () => {
        dispatch({ type: 'socket', connected: false });
        if (!closed) timer = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socketRef.current?.close();
    };
  }, [tenantId]);

  // Queues the message while the socket is connecting or reconnecting (sending on a
  // CONNECTING socket throws); it goes out as soon as the next socket opens.
  const send = useCallback((m: ClientMessage) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    else pendingRef.current.push(m);
  }, []);
  return { state, dispatch, send };
}

/** What {@link useLiveRoom} knows about the LiveKit room. */
export type RoomState = {
  /** The `livekit-client` room once connected, for advanced use. */
  room: Room | null;
  connected: boolean;
  /** Local microphone muted (only meaningful when publishing). */
  muted: boolean;
  /** Remote participants with the `role` attribute set by the API/agent (`customer`, `ai`, ...). */
  peers: { identity: string; name: string; role: string }[];
};

/**
 * Joins a LiveKit room with the given token, plays remote audio, exposes mute/leave.
 *
 * Connects when `join` becomes non-null and disconnects on unmount or when `join`
 * changes identity, so callers should keep the object stable (state, not a literal).
 * With `publish: true` the microphone is enabled right after connecting (agent / take
 * over); with `false` the desk only listens (supervisor listen-in). Every subscribed
 * remote audio track is attached as an `<audio>` element inside the node referenced by
 * `audioRef`, so the component must render `<div ref={audioRef} />` somewhere.
 *
 * @param join token + LiveKit URL from `POST /api/desk/calls/:id/accept` or `/join`.
 */
export function useLiveRoom(join: { token: string; url: string; publish: boolean } | null) {
  const [state, setState] = useState<RoomState>({
    room: null,
    connected: false,
    muted: false,
    peers: [],
  });
  const audioRef = useRef<HTMLDivElement | null>(null);
  // Serializes `setHeld`: `desired` is what the latest caller wants, `applied` what the
  // room currently does, `chain` the promise every call queues behind.
  const holdRef = useRef<{ desired: boolean; applied: boolean | null; chain: Promise<void> }>({
    desired: false,
    applied: null,
    chain: Promise.resolve(),
  });

  useEffect(() => {
    if (!join) return;
    holdRef.current = { desired: false, applied: null, chain: Promise.resolve() };
    const room = new Room();
    const peers = () =>
      [...room.remoteParticipants.values()].map((p) => ({
        identity: p.identity,
        name: p.name ?? '',
        role: p.attributes['role'] ?? '',
      }));
    const refresh = () => setState((s) => ({ ...s, peers: peers() }));
    room
      .on(RoomEvent.ParticipantConnected, refresh)
      .on(RoomEvent.ParticipantDisconnected, refresh)
      // Attributes can arrive after the participant (the AI sets its own), hence refresh.
      .on(RoomEvent.ParticipantAttributesChanged, refresh)
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        // Hold music is for the customer; the desk stays silent on `media` tracks.
        if (participant?.attributes['role'] === 'media') return;
        if (track.kind === Track.Kind.Audio) audioRef.current?.append(track.attach());
      })
      // Hold unsubscribes the remote audio: drop the orphaned `<audio>` elements too, so
      // retrieve does not stack a fresh element next to a dead one.
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        for (const el of track.detach()) el.remove();
      })
      .on(RoomEvent.Disconnected, () => setState((s) => ({ ...s, connected: false })));
    void (async () => {
      await room.connect(join.url, join.token);
      if (join.publish) await room.localParticipant.setMicrophoneEnabled(true);
      setState({ room, connected: true, muted: false, peers: peers() });
    })();
    return () => {
      void room.disconnect().catch(() => undefined);
      audioRef.current?.replaceChildren();
      setState({ room: null, connected: false, muted: false, peers: [] });
    };
  }, [join]);

  /** Toggles the local microphone; no-op before the room is connected. */
  const toggleMute = useCallback(async () => {
    if (!state.room) return;
    const muted = !state.muted;
    await state.room.localParticipant.setMicrophoneEnabled(!muted);
    setState((s) => ({ ...s, muted }));
  }, [state.room, state.muted]);

  /**
   * Local side of putting the customer on hold: stop subscribing to remote audio (the
   * agent hears silence) and mute the microphone (the customer hears only the music).
   * Retrieve re-enables both. Calls never overlap — each one queues behind the previous
   * and applies the *latest* requested state, so a quick hold → retrieve → hold ends up
   * held exactly once. The subscribe loop runs synchronously, before the microphone
   * round-trip; the media participant (hold music for the customer) is never touched.
   */
  const setHeld = useCallback(
    (held: boolean): Promise<void> => {
      const room = state.room;
      if (!room) return Promise.resolve();
      const ref = holdRef.current;
      ref.desired = held;
      const apply = async () => {
        const want = ref.desired;
        if (want === ref.applied) return;
        ref.applied = want;
        for (const participant of room.remoteParticipants.values()) {
          if (participant.attributes['role'] === 'media') continue;
          for (const publication of participant.trackPublications.values()) {
            publication.setSubscribed(!want);
          }
        }
        setState((s) => ({ ...s, muted: want }));
        await room.localParticipant.setMicrophoneEnabled(!want);
      };
      const next = ref.chain.then(apply);
      ref.chain = next.catch(() => undefined);
      return next;
    },
    [state.room],
  );

  return { ...state, audioRef, toggleMute, setHeld };
}

/** Current hash route, re-rendering on navigation. */
export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

/** Ticks every second; for timers and countdowns. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}
