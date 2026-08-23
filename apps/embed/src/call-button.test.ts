// @vitest-environment jsdom
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import de from './locales/de.json';
import it_ from './locales/it.json';

/** Minimal `livekit-client` stand-in: the element test only needs to see `disconnect`. */
const lk = vi.hoisted(() => {
  const rooms: FakeRoom[] = [];
  class FakeRoom {
    remoteParticipants = new Map();
    localParticipant = { setMicrophoneEnabled: vi.fn(() => Promise.resolve()) };
    connect = vi.fn(() => Promise.resolve());
    disconnect = vi.fn(() => Promise.resolve());
    constructor() {
      rooms.push(this);
    }
    on() {
      return this;
    }
  }
  return { rooms, FakeRoom };
});
vi.mock('livekit-client', () => ({
  Room: lk.FakeRoom,
  RoomEvent: {},
  Track: { Kind: { Audio: 'audio' } },
}));

const SCRIPT_ORIGIN = 'https://cdn.example';
const fetchMock = vi.fn();

/** Lets React commit and the `start` promise chain settle. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Accessors for the shadow DOM of one element. */
const ui = (el: HTMLElement) => ({
  button: (text: string) =>
    [...el.shadowRoot!.querySelectorAll('button')].find((b) => b.textContent === text)!,
  status: () => el.shadowRoot!.querySelector('.status')!.textContent,
});

const mount = (attrs: Record<string, string>) => {
  const el = document.createElement('cc-call-button');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
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
  expect(customElements.get('cc-call-button')).toBeTruthy();
});

describe('<cc-call-button>', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    lk.rooms.length = 0;
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('renders React into its shadow root and follows attribute changes', async () => {
    const el = mount({ key: 'pk_1', language: 'de' });
    await flush();
    expect(ui(el).button(de.callUs)).toBeTruthy();
    expect(ui(el).status()).toBe('');
    el.setAttribute('label', 'Ring');
    await flush();
    expect(ui(el).button('Ring')).toBeTruthy();
    el.removeAttribute('label');
    el.setAttribute('language', 'it');
    await flush();
    expect(ui(el).button(it_.callUs)).toBeTruthy();
  });

  it('defaults the api to the script origin and the language to the page', async () => {
    document.documentElement.lang = 'de-CH';
    const el = mount({ key: 'pk_1', queue: 'sales', label: 'Ring' });
    await flush();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'tok', url: 'wss://lk' }), { status: 200 }),
    );
    await userEvent.setup().click(ui(el).button('Ring'));
    await flush();
    document.documentElement.lang = '';
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
    expect(lk.rooms[0]!.connect).toHaveBeenCalledWith('wss://lk', 'tok');
    // The page language also picks the UI translation.
    expect(ui(el).status()).toBe(de.pleaseHold);
  });

  it('uses the api attribute and the browser language when the page has none', async () => {
    const el = mount({ key: 'pk_1', api: 'https://api.example' });
    await flush();
    fetchMock.mockRejectedValueOnce('offline');
    ui(el).button('Call us').click();
    await flush();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example/api/public/calls');
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1].body).language).toBe(navigator.language);
    expect(ui(el).status()).toBe('Could not start the call: offline');
  });

  it('leaves the room when removed from the page', async () => {
    const el = mount({ key: 'pk_1' });
    await flush();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ token: 'tok', url: 'wss://lk' }), { status: 200 }),
    );
    ui(el).button('Call us').click();
    await flush();
    const room = lk.rooms[0]!;
    el.remove();
    await flush();
    expect(room.disconnect).toHaveBeenCalled();
    expect(el.shadowRoot!.childElementCount).toBe(0);
    // Re-attaching mounts a fresh button; removing an idle one is harmless.
    document.body.append(el);
    await flush();
    expect(ui(el).button('Call us')).toBeTruthy();
    el.remove();
  });
});
