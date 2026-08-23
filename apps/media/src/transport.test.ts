import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransport } from './transport.ts';

const lk = vi.hoisted(() => {
  const captured: { data: Int16Array; sampleRate: number; channels: number; n: number }[] = [];
  // Frames are released one by one so the test controls the pump's pace.
  let release: ((err?: Error) => void)[] = [];
  class FakeRoom {
    static instances: FakeRoom[] = [];
    handlers = new Map<string, () => void>();
    localParticipant = { publishTrack: vi.fn(async () => undefined) };
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn(async () => undefined);
    on(event: string, handler: () => void) {
      this.handlers.set(event, handler);
      return this;
    }
    constructor() {
      FakeRoom.instances.push(this);
    }
  }
  return {
    captured,
    releaseNext: () => release.shift()?.(),
    reset: () => {
      captured.length = 0;
      release = [];
    },
    FakeRoom,
    closed: vi.fn(async () => undefined),
    AudioSource: class {
      captureFrame = (f: (typeof captured)[number]) => {
        captured.push(f);
        return new Promise<void>((resolve, reject) =>
          release.push((err) => (err ? reject(err) : resolve())),
        );
      };
      close = () => {
        // Like the SDK, closing fails whatever capture is still pending.
        for (const r of release.splice(0)) r(new Error('closed'));
        return lk.closed();
      };
    },
    AudioFrame: class {
      constructor(
        public data: Int16Array,
        public sampleRate: number,
        public channels: number,
        public n: number,
      ) {}
    },
    Room: FakeRoom,
    LocalAudioTrack: { createAudioTrack: vi.fn(() => ({ kind: 'audio' })) },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 1 },
    RoomEvent: { Disconnected: 'disconnected' },
  };
});
vi.mock('@livekit/rtc-node', () => lk);

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createTransport', () => {
  beforeEach(() => {
    lk.FakeRoom.instances.length = 0;
    lk.reset();
    lk.closed.mockClear();
  });

  it('joins, pushes zero-offset frames that walk and wrap the loop, and stops on disconnect', async () => {
    const connect = createTransport();
    const session = await connect('wss://x', 'tok');
    const room = lk.FakeRoom.instances[0]!;
    expect(room.connect).toHaveBeenCalledWith('wss://x', 'tok', {
      autoSubscribe: false,
      dynacast: false,
    });

    // A loop of 2.5 frames so the third frame straddles the wrap.
    const samples = Int16Array.from({ length: 10 }, (_, i) => i + 1);
    await session.publish(samples, 48_000, 4);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    await tick();
    expect(lk.captured.length).toBe(1); // blocked on the first captureFrame (SDK paces)
    lk.releaseNext();
    await tick();
    lk.releaseNext();
    await tick();
    expect(lk.captured.length).toBe(3);
    const frames = lk.captured.map((f) => [...f.data]);
    expect(frames).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 1, 2],
    ]);
    for (const f of lk.captured) {
      expect(f.data.byteOffset).toBe(0); // the SDK ignores byteOffset, so copies are a must
      expect(f.data.buffer.byteLength).toBe(8);
      expect([f.sampleRate, f.channels, f.n]).toEqual([48_000, 1, 4]);
    }

    const closed = vi.fn();
    session.onClosed(closed);
    room.handlers.get('disconnected')!();
    expect(closed).toHaveBeenCalledTimes(1);

    await session.disconnect(); // the pending capture is failed by close(), the pump ends
    expect(lk.closed).toHaveBeenCalledTimes(1);
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    await tick();
    expect(lk.captured.length).toBe(3); // nothing pushed after disconnect
  });

  it('disconnects cleanly when nothing was ever published', async () => {
    const session = await createTransport()('wss://x', 'tok');
    await session.disconnect();
    expect(lk.FakeRoom.instances[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(lk.closed).not.toHaveBeenCalled();
  });

  it('still leaves the room when closing the source fails', async () => {
    const session = await createTransport()('wss://x', 'tok');
    await session.publish(new Int16Array(8), 48_000, 4);
    await tick();
    lk.closed.mockRejectedValueOnce(new Error('closed'));
    await session.disconnect();
    expect(lk.captured.length).toBe(1);
    expect(lk.FakeRoom.instances[0]!.disconnect).toHaveBeenCalledTimes(1);
  });
});
