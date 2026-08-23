// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDeskSocket, useLiveRoom, useNow, useRoute } from './hooks.ts';

/** In-memory stand-ins for `livekit-client`, hoisted so the module mock can use them. */
const lk = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  type Participant = {
    identity: string;
    name?: string;
    attributes: Record<string, string>;
    trackPublications?: Map<string, { setSubscribed: (v: boolean) => void }>;
  };
  const rooms: FakeRoom[] = [];
  class FakeRoom {
    handlers = new Map<string, Handler[]>();
    remoteParticipants = new Map<string, Participant>();
    localParticipant = { setMicrophoneEnabled: vi.fn(() => Promise.resolve()) };
    connect = vi.fn(() => Promise.resolve());
    disconnect = vi.fn(() => Promise.resolve());
    constructor() {
      rooms.push(this);
    }
    on(event: string, fn: Handler) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
  }
  return {
    rooms,
    FakeRoom,
    RoomEvent: {
      ParticipantConnected: 'participantConnected',
      ParticipantDisconnected: 'participantDisconnected',
      ParticipantAttributesChanged: 'participantAttributesChanged',
      TrackSubscribed: 'trackSubscribed',
      TrackUnsubscribed: 'trackUnsubscribed',
      Disconnected: 'disconnected',
    },
    Track: { Kind: { Audio: 'audio', Video: 'video' } },
  };
});
vi.mock('livekit-client', () => ({ Room: lk.FakeRoom, RoomEvent: lk.RoomEvent, Track: lk.Track }));

/** Controllable `WebSocket` double; tests drive `onopen`/`onmessage`/`onclose` by hand. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  static readonly OPEN = 1;
  readyState = 0;
  send = vi.fn();
  close = vi.fn(() => this.onclose?.());
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
}

describe('useDeskSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('stays closed without a tenant', () => {
    renderHook(() => useDeskSocket(undefined));
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("adds the tab's dev user to the socket URL", () => {
    sessionStorage.setItem('cc_dev_user', 'alice@patchbay.dev');
    try {
      renderHook(() => useDeskSocket('t1'));
      expect(FakeWebSocket.instances[0]!.url).toBe(
        `ws://${location.host}/api/ws?tenantId=t1&as=alice%40patchbay.dev`,
      );
    } finally {
      sessionStorage.clear();
    }
  });

  it('connects, reduces frames, sends, and reconnects after a drop', () => {
    const { result, unmount } = renderHook(() => useDeskSocket('t1'));
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe(`ws://${location.host}/api/ws?tenantId=t1`);
    // Sent while still connecting: queued, not thrown, delivered on open.
    act(() => result.current.send({ type: 'subscribe', callId: 'early' }));
    expect(ws.send).not.toHaveBeenCalled();
    ws.readyState = FakeWebSocket.OPEN;
    act(() => ws.onopen?.());
    expect(result.current.state.connected).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'subscribe', callId: 'early' }));
    act(() =>
      ws.onmessage?.({
        data: JSON.stringify({ type: 'call.updated', callId: 'c', status: 'ai' }),
      }),
    );
    expect(result.current.state.callStatus).toEqual({ c: 'ai' });

    act(() => result.current.send({ type: 'subscribe', callId: 'c' }));
    expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'subscribe', callId: 'c' }));

    // Dropped by the server: reconnect after 2 s.
    act(() => ws.onclose?.());
    expect(result.current.state.connected).toBe(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(2000));
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Deliberate close on unmount: no further reconnect.
    unmount();
    expect(FakeWebSocket.instances[1]!.close).toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(5000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('stops reconnecting after a forced logout', () => {
    const { result } = renderHook(() => useDeskSocket('t1'));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.onmessage?.({ data: JSON.stringify({ type: 'logout', by: 'Boss' }) }));
    expect(result.current.state.loggedOutBy).toBe('Boss');
    act(() => ws.onclose?.());
    act(() => void vi.advanceTimersByTime(5000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('closes the socket on unmount before any drop', () => {
    const { unmount } = renderHook(() => useDeskSocket('t1'));
    unmount();
    expect(FakeWebSocket.instances[0]!.close).toHaveBeenCalledTimes(1);
  });

  it('clears a pending reconnect timer on cleanup', () => {
    const { unmount } = renderHook(() => useDeskSocket('t1'));
    act(() => FakeWebSocket.instances[0]!.onclose?.());
    unmount();
    act(() => void vi.advanceTimersByTime(5000));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('useLiveRoom', () => {
  beforeEach(() => {
    lk.rooms.length = 0;
  });

  const join = { token: 'tok', url: 'wss://lk', publish: true };
  const listenOnly = { ...join, publish: false };

  it('does nothing without join info', async () => {
    const { result } = renderHook(() => useLiveRoom(null));
    expect(result.current.connected).toBe(false);
    expect(lk.rooms).toHaveLength(0);
    // hold without a room is a no-op
    await result.current.setHeld(true);
    expect(result.current.muted).toBe(false);
  });

  it('connects, publishes, tracks peers and audio, mutes and cleans up', async () => {
    const { result, unmount } = renderHook(() => useLiveRoom(join));
    const room = lk.rooms[0]!;
    const holder = document.createElement('div');
    result.current.audioRef.current = holder;
    room.remoteParticipants.set('customer:1', {
      identity: 'customer:1',
      attributes: { role: 'customer' },
    });
    await act(async () => {});
    expect(room.connect).toHaveBeenCalledWith('wss://lk', 'tok');
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(result.current.connected).toBe(true);
    expect(result.current.peers).toEqual([{ identity: 'customer:1', name: '', role: 'customer' }]);

    room.remoteParticipants.set('ai:1', { identity: 'ai:1', name: 'AI', attributes: {} });
    act(() => room.emit(lk.RoomEvent.ParticipantConnected));
    expect(result.current.peers).toHaveLength(2);
    expect(result.current.peers[1]).toEqual({ identity: 'ai:1', name: 'AI', role: '' });
    room.remoteParticipants.get('ai:1')!.attributes = { role: 'ai' };
    act(() => room.emit(lk.RoomEvent.ParticipantAttributesChanged));
    expect(result.current.peers[1]?.role).toBe('ai');
    room.remoteParticipants.delete('ai:1');
    act(() => room.emit(lk.RoomEvent.ParticipantDisconnected));
    expect(result.current.peers).toHaveLength(1);

    const audioEl = document.createElement('audio');
    act(() => {
      room.emit(lk.RoomEvent.TrackSubscribed, { kind: 'audio', attach: () => audioEl });
      room.emit(lk.RoomEvent.TrackSubscribed, {
        kind: 'video',
        attach: () => document.createElement('video'),
      });
    });
    expect([...holder.children]).toEqual([audioEl]);

    await act(() => result.current.toggleMute());
    expect(result.current.muted).toBe(true);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    await act(() => result.current.toggleMute());
    expect(result.current.muted).toBe(false);

    act(() => room.emit(lk.RoomEvent.Disconnected));
    expect(result.current.connected).toBe(false);

    unmount();
    expect(room.disconnect).toHaveBeenCalled();
    expect(holder.children).toHaveLength(0);
  });

  it('holds and retrieves in order, skipping the media participant', async () => {
    const { result } = renderHook(() => useLiveRoom(join));
    const room = lk.rooms[0]!;
    await act(async () => {});
    expect(result.current.connected).toBe(true);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledTimes(1);
    const calls: string[] = [];
    const pub = (name: string) => ({ setSubscribed: (v: boolean) => calls.push(`${name}:${v}`) });
    room.remoteParticipants.set('customer:1', {
      identity: 'customer:1',
      attributes: { role: 'customer' },
      trackPublications: new Map([['a', pub('customer')]]),
    });
    room.remoteParticipants.set('media:1', {
      identity: 'media:1',
      attributes: { role: 'media' },
      trackPublications: new Map([['b', pub('media')]]),
    });
    // The microphone round-trip is slow: the subscribe loop must not wait for it.
    let release: () => void = () => undefined;
    room.localParticipant.setMicrophoneEnabled.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    let first: Promise<void>;
    await act(async () => {
      first = result.current.setHeld(true);
    });
    expect(calls).toEqual(['customer:false']);
    expect(result.current.muted).toBe(true);
    // Two more requests while the first is in flight: only the last one is applied.
    let second: Promise<void>;
    await act(async () => {
      void result.current.setHeld(false);
      second = result.current.setHeld(true);
    });
    expect(calls).toEqual(['customer:false']);
    release();
    await act(async () => {
      await first;
      await second;
    });
    // still held: the intermediate retrieve was superseded before it ran
    expect(calls).toEqual(['customer:false']);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    await act(() => result.current.setHeld(false));
    expect(calls).toEqual(['customer:false', 'customer:true']);
    expect(result.current.muted).toBe(false);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
    // A failing microphone call does not wedge the chain.
    room.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error('mic'));
    await act(async () => {
      await result.current.setHeld(true).catch(() => undefined);
    });
    await act(() => result.current.setHeld(false));
    expect(calls).toEqual(['customer:false', 'customer:true', 'customer:false', 'customer:true']);
  });

  it('removes the audio element when a track is unsubscribed', async () => {
    const { result } = renderHook(() => useLiveRoom(join));
    const room = lk.rooms[0]!;
    const holder = document.createElement('div');
    result.current.audioRef.current = holder;
    await act(async () => {});
    const audioEl = document.createElement('audio');
    const track = { kind: 'audio', attach: () => audioEl, detach: () => [audioEl] };
    act(() => room.emit(lk.RoomEvent.TrackSubscribed, track));
    expect([...holder.children]).toEqual([audioEl]);
    act(() => room.emit(lk.RoomEvent.TrackUnsubscribed, track));
    expect(holder.children).toHaveLength(0);
  });

  it('only listens when publish is false and ignores mute before connecting', async () => {
    const { result } = renderHook(() => useLiveRoom(listenOnly));
    await act(() => result.current.toggleMute());
    expect(result.current.muted).toBe(false);
    await act(async () => {});
    expect(lk.rooms[0]!.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(result.current.connected).toBe(true);
  });
});

describe('useRoute', () => {
  it('follows hash changes', () => {
    location.hash = '#/history';
    const { result, unmount } = renderHook(() => useRoute());
    expect(result.current).toEqual({ page: 'history' });
    act(() => {
      location.hash = '#/calls/abc';
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(result.current).toEqual({ page: 'call', id: 'abc' });
    unmount();
    location.hash = '';
  });
});

describe('useNow', () => {
  it('ticks every second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { result, unmount } = renderHook(() => useNow());
    expect(result.current).toBe(1_000);
    act(() => void vi.advanceTimersByTime(1_000));
    expect(result.current).toBe(2_000);
    unmount();
    vi.useRealTimers();
  });
});
