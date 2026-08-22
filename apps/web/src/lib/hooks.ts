import type { AgentStatus, ClientMessage, ServerMessage } from '@cc/shared';
import { Room, RoomEvent, Track } from 'livekit-client';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialState, parseRoute, reduce } from './store.ts';

/** Desk websocket: reconnects on close, exposes the reduced state and a sender. */
export function useDeskSocket(tenantId: string | undefined) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!tenantId) return;
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

export type RoomState = {
  room: Room | null;
  connected: boolean;
  muted: boolean;
  peers: { identity: string; name: string; role: string }[];
};

/** Joins a LiveKit room with the given token, plays remote audio, exposes mute/leave. */
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
