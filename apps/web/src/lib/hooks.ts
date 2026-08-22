/**
 * React hooks of the agent desk.
 *
 * - {@link useDeskSocket}: owns the websocket to `/api/ws` and the reduced `DeskState`
 *   (see `store.ts`); every page gets its return value as the `desk` prop.
 * - {@link useLiveRoom}: wraps a `livekit-client` `Room` (connect, microphone, remote
 *   audio playback, peer list, mute) for the in-call view.
 * - {@link useRoute}: current hash route.
 * - {@link useNow}: a one-second ticker for countdowns and durations.
 */
import type { AgentStatus, ClientMessage, ServerMessage } from '@cc/shared';
import { Room, RoomEvent, Track } from 'livekit-client';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialState, parseRoute, reduce } from './store.ts';

/**
 * Desk websocket: reconnects on close, exposes the reduced state and a sender.
 *
 * Opens `ws(s)://<host>/api/ws?tenantId=…` (proxied to the API in dev). Every frame is a
 * `ServerMessage` and goes straight into {@link reduce}. If the socket closes for any
 * reason (API restart, network blip) it is reopened after two seconds, forever, until
 * the component unmounts or `tenantId` changes. The server treats a fresh connection as
 * a fresh presence, so after a reconnect the agent is `away` again server-side even
 * though `state.myStatus` still shows the last choice.
 *
 * @param tenantId the tenant to connect for; `undefined` keeps the socket closed.
 * @returns `state` (`DeskState`), the raw `dispatch`, `send` for `ClientMessage`s
 * and `setStatus` (updates the local state and tells the server).
 */
export function useDeskSocket(tenantId: string | undefined) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!tenantId) return;
    // `closed` distinguishes a deliberate close (cleanup) from a dropped connection:
    // only the latter schedules a reconnect.
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/api/ws?tenantId=${tenantId}`);
      socketRef.current = ws;
      ws.onopen = () => dispatch({ type: 'socket', connected: true });
      ws.onmessage = (e) =>
        dispatch({ type: 'server', message: JSON.parse(String(e.data)) as ServerMessage });
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

  // Silently drops the message when the socket is not open (e.g. during a reconnect).
  const send = useCallback((m: ClientMessage) => socketRef.current?.send(JSON.stringify(m)), []);
  const setStatus = useCallback(
    (status: AgentStatus) => {
      dispatch({ type: 'myStatus', status });
      send({ type: 'status', status });
    },
    [send],
  );
  return { state, dispatch, send, setStatus };
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

  useEffect(() => {
    if (!join) return;
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
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) audioRef.current?.append(track.attach());
      })
      .on(RoomEvent.Disconnected, () => setState((s) => ({ ...s, connected: false })));
    void (async () => {
      await room.connect(join.url, join.token);
      if (join.publish) await room.localParticipant.setMicrophoneEnabled(true);
      setState({ room, connected: true, muted: false, peers: peers() });
    })();
    return () => {
      void room.disconnect();
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

  return { ...state, audioRef, toggleMute };
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
