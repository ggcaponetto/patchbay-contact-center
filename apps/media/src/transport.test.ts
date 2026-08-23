import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransport } from './transport.ts';

const lk = vi.hoisted(() => {
  const captured: unknown[] = [];
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
    FakeRoom,
    AudioSource: class {
      captureFrame = (f: unknown) => {
        captured.push(f);
        return Promise.resolve();
      };
    },
    AudioFrame: class {
      constructor(public data: Int16Array) {}
    },
    Room: FakeRoom,
    LocalAudioTrack: { createAudioTrack: vi.fn(() => ({ kind: 'audio' })) },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 1 },
    RoomEvent: { Disconnected: 'disconnected' },
  };
});
vi.mock('@livekit/rtc-node', () => lk);

describe('createTransport', () => {
  beforeEach(() => {
    lk.FakeRoom.instances.length = 0;
    lk.captured.length = 0;
    vi.useFakeTimers();
  });

  it('joins, publishes looping frames, reports the close and disconnects', async () => {
    const connect = createTransport();
    const session = await connect('wss://x', 'tok');
    const room = lk.FakeRoom.instances[0]!;
    expect(room.connect).toHaveBeenCalledWith('wss://x', 'tok', {
      autoSubscribe: false,
      dynacast: false,
    });

    const samples = new Int16Array(480 * 3); // three frames worth of loop
    await session.publish(samples, 48_000, 480);
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(lk.captured.length).toBe(5); // one frame per 10 ms tick

    const closed = vi.fn();
    session.onClosed(closed);
    room.handlers.get('disconnected')!();
    expect(closed).toHaveBeenCalledTimes(1);

    await session.disconnect();
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(50);
    expect(lk.captured.length).toBe(5); // the frame timer stopped
    vi.useRealTimers();
  });

  it('disconnects cleanly when nothing was ever published', async () => {
    const session = await createTransport()('wss://x', 'tok');
    await session.disconnect();
    expect(lk.FakeRoom.instances[0]!.disconnect).toHaveBeenCalledTimes(1);
  });
});
