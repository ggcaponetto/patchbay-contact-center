// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

const SCRIPT_ORIGIN = 'https://cdn.example';
const fetchMock = vi.fn();

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

/** Lets the `startCall` promise chain (fetch → connect → mic) settle. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Accessors for the shadow DOM of one button. */
const ui = (el: HTMLElement) => ({
  buttons: () => [...el.shadowRoot!.querySelectorAll('button')],
  button: (text: string) =>
    [...el.shadowRoot!.querySelectorAll('button')].find((b) => b.textContent === text)!,
  status: () => el.shadowRoot!.querySelector('.status')!.textContent,
  audio: () => el.shadowRoot!.querySelector('.status')!.nextElementSibling!,
});

const mount = (attrs: Record<string, string>) => {
  const el = document.createElement('cc-call-button');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
};

/** Clicks the call button and resolves the API call with a token. */
const startCall = async (el: HTMLElement) => {
  fetchMock.mockResolvedValueOnce(json({ token: 'tok', url: 'wss://lk' }));
  ui(el).button('Ring').click();
  await flush();
  return lk.rooms.at(-1)!;
};

beforeAll(async () => {
  // `document.currentScript` is captured at module load: simulate the script tag.
  Object.defineProperty(document, 'currentScript', {
    value: { src: `${SCRIPT_ORIGIN}/embed/call-button.js` },
    configurable: true,
  });
  await import('./call-button.ts');
  // Importing twice must not redefine the element.
  await import('./call-button.ts');
});

describe('<cc-call-button>', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    lk.rooms.length = 0;
    lk.setOnCreate(undefined);
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders the idle button with the default label', () => {
    const el = mount({ key: 'pk_1' });
    expect(ui(el).button('Call us')).toBeTruthy();
    expect(ui(el).status()).toBe('');
  });

  it('refuses to call without a key and never touches the network', async () => {
    const el = mount({});
    ui(el).button('Call us').click();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ui(el).status()).toContain('key attribute is missing');
  });

  it('runs a full call: connect, peers, audio, mute, timer, hang up', async () => {
    const el = mount({ key: 'pk_1', queue: 'sales', label: 'Ring' });
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    document.documentElement.lang = 'de-CH';
    ui(el).button('Ring').click();
    expect(ui(el).button('Ring').disabled).toBe(true);
    expect(ui(el).status()).toBe('Connecting…');
    expect(fetchMock).toHaveBeenCalledWith(`${SCRIPT_ORIGIN}/api/public/calls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        embedKey: 'pk_1',
        queue: 'sales',
        language: 'de-CH',
        customerMeta: { page: location.href, userAgent: navigator.userAgent },
      }),
    });
    document.documentElement.lang = '';
    // A second click while connecting is ignored by the reducer.
    ui(el).button('Ring').click();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    document.body.replaceChildren();

    const el2 = mount({ key: 'pk_1', label: 'Ring' });
    const room = await startCall(el2);
    expect(room.connect).toHaveBeenCalledWith('wss://lk', 'tok');
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(ui(el2).status()).toBe('Please hold, connecting you…');
    expect(
      ui(el2)
        .buttons()
        .map((b) => b.textContent),
    ).toEqual(['Mute', 'Hang up']);

    // Peers: no role yet → ignored; AI → in call; local attribute change → ignored; human → label.
    room.emit(lk.RoomEvent.ParticipantConnected, { identity: 'x', attributes: {} });
    expect(ui(el2).status()).toBe('Please hold, connecting you…');
    room.emit(
      lk.RoomEvent.ParticipantAttributesChanged,
      {},
      {
        identity: 'ai:1',
        attributes: { role: 'ai' },
      },
    );
    expect(ui(el2).status()).toBe('AI assistant · 0:00');
    room.emit(
      lk.RoomEvent.ParticipantAttributesChanged,
      {},
      {
        isLocal: true,
        attributes: { role: 'human' },
      },
    );
    expect(ui(el2).status()).toBe('AI assistant · 0:00');
    room.emit(lk.RoomEvent.ParticipantConnected, {
      identity: 'human:u',
      name: 'Sam',
      attributes: { role: 'human' },
    });
    expect(ui(el2).status()).toBe('Agent Sam · 0:00');

    // Audio tracks are attached, video is not.
    const audioEl = document.createElement('audio');
    room.emit(lk.RoomEvent.TrackSubscribed, { kind: 'audio', attach: () => audioEl });
    room.emit(lk.RoomEvent.TrackSubscribed, {
      kind: 'video',
      attach: () => document.createElement('video'),
    });
    // ... and a whispering supervisor is never audible to the customer.
    room.emit(
      lk.RoomEvent.TrackSubscribed,
      { kind: 'audio', attach: () => document.createElement('audio') },
      undefined,
      { attributes: { role: 'supervisor', monitor: 'whisper' } },
    );
    expect([...ui(el2).audio().children]).toEqual([audioEl]);

    // Mute / unmute.
    ui(el2).button('Mute').click();
    await flush();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    expect(ui(el2).button('Unmute')).toBeTruthy();
    ui(el2).button('Unmute').click();
    await flush();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);

    // The duration ticks.
    vi.advanceTimersByTime(2_000);
    expect(ui(el2).status()).toBe('Agent Sam · 0:02');

    ui(el2).button('Hang up').click();
    await flush();
    expect(room.disconnect).toHaveBeenCalled();
    expect(ui(el2).status()).toBe('Call ended. Thanks for calling!');
    expect(ui(el2).audio().children).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    expect(ui(el2).status()).toBe('Call ended. Thanks for calling!');
  });

  it('announces peers already in the room and ends on Disconnected', async () => {
    const el = mount({ key: 'pk_1', label: 'Ring' });
    fetchMock.mockResolvedValueOnce(json({ token: 'tok', url: 'wss://lk' }));
    lk.setOnCreate((r) =>
      r.remoteParticipants.set('ai:1', { identity: 'ai:1', attributes: { role: 'ai' } }),
    );
    ui(el).button('Ring').click();
    await flush();
    const room = lk.rooms[0]!;
    expect(ui(el).status()).toBe('AI assistant · 0:00');
    room.emit(lk.RoomEvent.Disconnected);
    await flush();
    expect(ui(el).status()).toBe('Call ended. Thanks for calling!');
    expect(ui(el).button('Ring')).toBeTruthy();
  });

  it('uses the api attribute when present', async () => {
    const el = mount({ key: 'pk_1', label: 'Ring', api: 'https://api.example' });
    await startCall(el);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example/api/public/calls');
  });

  it('reports API and connection failures', async () => {
    const el = mount({ key: 'pk_1', label: 'Ring' });
    fetchMock.mockResolvedValueOnce(json({ error: 'invalid_key' }, { status: 403 }));
    ui(el).button('Ring').click();
    await flush();
    expect(ui(el).status()).toBe('Could not start the call: invalid_key');
    expect(lk.rooms).toHaveLength(0);

    fetchMock.mockResolvedValueOnce(
      new Response('oops', { status: 502, statusText: 'Bad Gateway' }),
    );
    ui(el).button('Ring').click();
    await flush();
    expect(ui(el).status()).toBe('Could not start the call: Bad Gateway');

    fetchMock.mockRejectedValueOnce('offline');
    ui(el).button('Ring').click();
    await flush();
    expect(ui(el).status()).toBe('Could not start the call: offline');

    // Connect failure after the room exists: the room is torn down.
    fetchMock.mockResolvedValueOnce(json({ token: 'tok', url: 'wss://lk' }));
    lk.setOnCreate((r) => r.connect.mockRejectedValueOnce(new Error('mic denied')));
    ui(el).button('Ring').click();
    await flush();
    const room = lk.rooms[0]!;
    expect(ui(el).status()).toBe('Could not start the call: mic denied');
    expect(room.disconnect).toHaveBeenCalled();
  });

  it('leaves the room when removed from the page', async () => {
    const el = mount({ key: 'pk_1', label: 'Ring' });
    const room = await startCall(el);
    el.remove();
    expect(room.disconnect).toHaveBeenCalled();
    // Removing an idle button is harmless.
    const idle = mount({ key: 'pk_1' });
    idle.remove();
  });
});
