// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallButton, type CallButtonProps } from './CallButton.tsx';
import de from './locales/de.json';
import it_ from './locales/it.json';

/** In-memory stand-ins for `livekit-client`, hoisted so the module mock can use them. */
const lk = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  type Participant = {
    identity: string;
    name?: string;
    isLocal?: boolean;
    attributes: Record<string, string>;
  };
  const rooms: FakeRoom[] = [];
  // Runs before `connect`, so tests can seed participants or make `connect` fail.
  let onCreate: ((room: FakeRoom) => void) | undefined;
  class FakeRoom {
    handlers = new Map<string, Handler[]>();
    remoteParticipants = new Map<string, Participant>();
    localParticipant = { setMicrophoneEnabled: vi.fn(() => Promise.resolve()) };
    connect = vi.fn(() => Promise.resolve());
    disconnect = vi.fn(() => Promise.resolve());
    constructor() {
      rooms.push(this);
      onCreate?.(this);
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
    setOnCreate: (fn: typeof onCreate) => {
      onCreate = fn;
    },
    RoomEvent: {
      ParticipantConnected: 'participantConnected',
      ParticipantAttributesChanged: 'participantAttributesChanged',
      TrackSubscribed: 'trackSubscribed',
      Disconnected: 'disconnected',
    },
    Track: { Kind: { Audio: 'audio', Video: 'video' } },
  };
});
vi.mock('livekit-client', () => ({ Room: lk.FakeRoom, RoomEvent: lk.RoomEvent, Track: lk.Track }));

const API = 'https://api.example';
const fetchMock = vi.fn();

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

/** Lets the `start` promise chain (fetch → connect → mic) settle inside `act`. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

const defaults: CallButtonProps = {
  embedKey: 'pk_1',
  queue: 'support',
  api: API,
  label: undefined,
  language: 'en',
};

/** Renders the component and returns accessors for its DOM. */
const mount = (props: Partial<CallButtonProps> = {}) => {
  const result = render(<CallButton {...defaults} {...props} />);
  const { container } = result;
  return {
    ...result,
    buttons: () => [...container.querySelectorAll('button')],
    button: (text: string) =>
      [...container.querySelectorAll('button')].find((b) => b.textContent === text)!,
    click: (text: string) => act(() => fireEvent.click(ui.button(text))),
    status: () => container.querySelector('.status')!.textContent,
    audio: () => container.querySelector('.status')!.nextElementSibling!,
  };
};
// Assigned per test so `click` can find buttons through the latest render.
let ui: ReturnType<typeof mount>;

/** Clicks the call button and resolves the API call with a token. */
const startCall = async (label = 'Call us') => {
  fetchMock.mockResolvedValueOnce(json({ token: 'tok', url: 'wss://lk' }));
  await ui.click(label);
  await flush();
  return lk.rooms.at(-1)!;
};

/** Emits a room event inside `act` so React flushes the resulting render. */
const emit = (room: InstanceType<typeof lk.FakeRoom>, event: string, ...args: unknown[]) =>
  act(() => room.emit(event, ...args));

describe('<CallButton>', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    lk.rooms.length = 0;
    lk.setOnCreate(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders the idle button with the translated default label', () => {
    ui = mount();
    expect(ui.button('Call us')).toBeTruthy();
    expect(ui.status()).toBe('');
  });

  it('refuses to call without a key and never touches the network', async () => {
    ui = mount({ embedKey: '' });
    await ui.click('Call us');
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ui.status()).toBe(
      'Could not start the call: the key attribute is missing (create one in Settings)',
    );
  });

  it('posts the call with its options and ignores a second click while connecting', async () => {
    ui = mount({ queue: 'sales', label: 'Ring', language: 'de-CH' });
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    await ui.click('Ring');
    expect(ui.button('Ring').disabled).toBe(true);
    expect(ui.status()).toBe(de.connecting);
    expect(fetchMock).toHaveBeenCalledWith(`${API}/api/public/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        embedKey: 'pk_1',
        queue: 'sales',
        language: 'de-CH',
        customerMeta: { page: location.href, userAgent: navigator.userAgent },
      }),
    });
    await ui.click('Ring');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('runs a full call: connect, peers, audio, mute, timer, hang up', async () => {
    ui = mount();
    const room = await startCall();
    expect(room.connect).toHaveBeenCalledWith('wss://lk', 'tok');
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(ui.status()).toBe('Please hold, connecting you…');
    expect(ui.buttons().map((b) => b.textContent)).toEqual(['Mute', 'Hang up']);

    // Peers: no role yet → ignored; AI → in call; local attribute change → ignored; human → label.
    await emit(room, lk.RoomEvent.ParticipantConnected, { identity: 'x', attributes: {} });
    expect(ui.status()).toBe('Please hold, connecting you…');
    await emit(
      room,
      lk.RoomEvent.ParticipantAttributesChanged,
      {},
      { identity: 'ai:1', attributes: { role: 'ai' } },
    );
    expect(ui.status()).toBe('AI assistant · 0:00');
    await emit(
      room,
      lk.RoomEvent.ParticipantAttributesChanged,
      {},
      { isLocal: true, attributes: { role: 'human' } },
    );
    expect(ui.status()).toBe('AI assistant · 0:00');
    await emit(room, lk.RoomEvent.ParticipantConnected, {
      identity: 'human:u',
      name: 'Sam',
      attributes: { role: 'human' },
    });
    expect(ui.status()).toBe('Agent Sam · 0:00');

    // Audio tracks are attached, video is not.
    const audioEl = document.createElement('audio');
    await emit(room, lk.RoomEvent.TrackSubscribed, { kind: 'audio', attach: () => audioEl });
    await emit(room, lk.RoomEvent.TrackSubscribed, {
      kind: 'video',
      attach: () => document.createElement('video'),
    });
    // ... and a whispering supervisor is never audible to the customer.
    await emit(
      room,
      lk.RoomEvent.TrackSubscribed,
      { kind: 'audio', attach: () => document.createElement('audio') },
      undefined,
      { attributes: { role: 'supervisor', monitor: 'whisper' } },
    );
    expect([...ui.audio().children]).toEqual([audioEl]);

    // Mute / unmute.
    await ui.click('Mute');
    await flush();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    expect(ui.button('Unmute')).toBeTruthy();
    await ui.click('Unmute');
    await flush();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);

    // The duration ticks.
    await act(() => vi.advanceTimersByTime(2_000));
    expect(ui.status()).toBe('Agent Sam · 0:02');

    await ui.click('Hang up');
    await flush();
    expect(room.disconnect).toHaveBeenCalled();
    expect(ui.status()).toBe('Call ended. Thanks for calling!');
    expect(ui.audio().children).toHaveLength(0);
    await act(() => vi.advanceTimersByTime(2_000));
    expect(ui.status()).toBe('Call ended. Thanks for calling!');
    // Mute is gone with the call: a stray toggle changes nothing.
    expect(ui.buttons().map((b) => b.textContent)).toEqual(['Call us']);
  });

  it('announces peers already in the room and ends on Disconnected', async () => {
    ui = mount();
    fetchMock.mockResolvedValueOnce(json({ token: 'tok', url: 'wss://lk' }));
    lk.setOnCreate((r) =>
      r.remoteParticipants.set('ai:1', { identity: 'ai:1', attributes: { role: 'ai' } }),
    );
    await ui.click('Call us');
    await flush();
    const room = lk.rooms[0]!;
    expect(ui.status()).toBe('AI assistant · 0:00');
    await emit(room, lk.RoomEvent.Disconnected);
    await flush();
    expect(ui.status()).toBe('Call ended. Thanks for calling!');
    expect(ui.button('Call us')).toBeTruthy();
  });

  it('shows a nameless agent without a trailing space', async () => {
    ui = mount();
    const room = await startCall();
    await emit(room, lk.RoomEvent.ParticipantConnected, {
      identity: 'human:u',
      attributes: { role: 'human' },
    });
    expect(ui.status()).toBe('Agent · 0:00');
  });

  it('reports API and connection failures', async () => {
    ui = mount();
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_key' }, { status: 403 }));
    await ui.click('Call us');
    await flush();
    expect(ui.status()).toBe('Could not start the call: invalid_key');
    expect(lk.rooms).toHaveLength(0);

    fetchMock.mockResolvedValueOnce(
      new Response('oops', { status: 502, statusText: 'Bad Gateway' }),
    );
    await ui.click('Call us');
    await flush();
    expect(ui.status()).toBe('Could not start the call: Bad Gateway');

    fetchMock.mockRejectedValueOnce('offline');
    await ui.click('Call us');
    await flush();
    expect(ui.status()).toBe('Could not start the call: offline');

    // Connect failure after the room exists: the room is torn down.
    fetchMock.mockResolvedValueOnce(json({ token: 'tok', url: 'wss://lk' }));
    lk.setOnCreate((r) => r.connect.mockRejectedValueOnce(new Error('mic denied')));
    await ui.click('Call us');
    await flush();
    expect(ui.status()).toBe('Could not start the call: mic denied');
    expect(lk.rooms[0]!.disconnect).toHaveBeenCalled();

    // Microphone refused after connecting.
    fetchMock.mockResolvedValueOnce(json({ token: 'tok', url: 'wss://lk' }));
    lk.setOnCreate((r) =>
      r.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(new Error('NotAllowed')),
    );
    await ui.click('Call us');
    await flush();
    expect(ui.status()).toBe('Could not start the call: NotAllowed');
    expect(lk.rooms[1]!.disconnect).toHaveBeenCalled();
  });

  it('leaves the room when unmounted', async () => {
    ui = mount();
    const room = await startCall();
    ui.unmount();
    expect(room.disconnect).toHaveBeenCalled();
    // Unmounting an idle button is harmless.
    mount().unmount();
  });

  it('loops the ringback while waiting and stops it once someone is there', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('x'));
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    ui = mount();
    fetchMock.mockResolvedValueOnce(
      json({ token: 'tok', url: 'wss://lk', sounds: { ringback: '/api/public/media/r1' } }),
    );
    await ui.click('Call us');
    await flush();
    const room = lk.rooms.at(-1)!;
    expect(play).toHaveBeenCalledTimes(1);
    const audio = play.mock.instances[0] as HTMLAudioElement;
    expect(audio.src).toBe(`${API}/api/public/media/r1`);
    expect(audio.loop).toBe(true);
    await emit(room, lk.RoomEvent.ParticipantConnected, {
      identity: 'ai',
      attributes: { role: 'ai' },
    });
    expect(pause).toHaveBeenCalledTimes(1);
    await ui.click('Hang up');
    await flush();
    expect(play).toHaveBeenCalledTimes(1); // never restarted after the peer arrived

    // An absolute ringback URL is used as is.
    fetchMock.mockResolvedValueOnce(
      json({ token: 'tok', url: 'wss://lk', sounds: { ringback: 'https://cdn/r.mp3' } }),
    );
    await ui.click('Call us');
    await flush();
    expect((play.mock.instances[1] as HTMLAudioElement).src).toBe('https://cdn/r.mp3');
    ui.unmount();
    expect(pause).toHaveBeenCalledTimes(2);
    play.mockRestore();
    pause.mockRestore();
  });

  it('waits silently when the tenant has no ringback', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    ui = mount();
    await startCall();
    expect(play).not.toHaveBeenCalled();
    play.mockRestore();
  });

  it('speaks German', async () => {
    ui = mount({ language: 'de' });
    const room = await startCall(de.callUs);
    expect(ui.status()).toBe(de.pleaseHold);
    expect(ui.buttons().map((b) => b.textContent)).toEqual([de.mute, de.hangUp]);
    await emit(room, lk.RoomEvent.ParticipantConnected, {
      identity: 'ai',
      attributes: { role: 'ai' },
    });
    expect(ui.status()).toBe(`${de.peers.ai} · 0:00`);
    await ui.click(de.mute);
    expect(ui.button(de.unmute)).toBeTruthy();
    await ui.click(de.hangUp);
    await flush();
    expect(ui.status()).toBe(de.ended);
  });

  it('speaks Italian for a regional tag and keeps an explicit label verbatim', async () => {
    ui = mount({ language: 'it-IT', label: 'Custom label' });
    expect(ui.button('Custom label')).toBeTruthy();
    const room = await startCall('Custom label');
    expect(ui.status()).toBe(it_.pleaseHold);
    await emit(room, lk.RoomEvent.ParticipantConnected, {
      identity: 'h',
      name: 'Sam',
      attributes: { role: 'human' },
    });
    expect(ui.status()).toBe(it_.peers.agent.replace('{{name}}', 'Sam') + ' · 0:00');
    ui.rerender(<CallButton {...defaults} language="it-IT" label={undefined} />);
    await ui.click(it_.hangUp);
    await flush();
    expect(ui.button(it_.callUs)).toBeTruthy();
    // A language without translations falls back to English.
    ui.rerender(<CallButton {...defaults} language="fr" />);
    expect(ui.button('Call us')).toBeTruthy();
  });
});
