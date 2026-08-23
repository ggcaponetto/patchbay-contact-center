/**
 * The LiveKit side of the media worker: joins a room with the token from a
 * {@link MediaCommand} and pushes the hold-music loop as 10 ms `AudioFrame`s until
 * disconnected. This is the `connect` dependency of `worker.ts`, kept in its own module
 * so it can be unit-tested with a mocked `@livekit/rtc-node`.
 *
 * Two details matter for clean audio. Every frame gets its own zero-offset
 * `Int16Array`: the SDK reads `frame.data.buffer` from byte 0 and ignores the view's
 * `byteOffset`, so a `subarray` of the loop would replay the first 10 ms forever (a
 * 100 Hz buzz). And frames are pushed by awaiting `captureFrame`, which blocks while the
 * source's internal queue (one second) is full — the SDK paces playback, not a timer.
 */
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { WorkerDeps } from './worker.ts';

/** Builds the real `connect` implementation for {@link WorkerDeps}. */
export function createTransport(): WorkerDeps['connect'] {
  return async (url, token) => {
    const room = new Room();
    await room.connect(url, token, { autoSubscribe: false, dynacast: false });
    let stopped = false;
    let running: Promise<void> = Promise.resolve();
    let source: AudioSource | null = null;
    let closed: () => void = () => undefined;
    room.on(RoomEvent.Disconnected, () => closed());
    return {
      onClosed: (handler) => {
        closed = handler;
      },
      async publish(samples, sampleRate, frameSamples) {
        source = new AudioSource(sampleRate, 1);
        const track = LocalAudioTrack.createAudioTrack('moh', source);
        const options = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
        await room.localParticipant?.publishTrack(track, options);
        running = pump(source, samples, sampleRate, frameSamples, () => stopped);
      },
      async disconnect() {
        stopped = true;
        // Closing the source first releases a capture the pump may be waiting on.
        await source?.close().catch(() => undefined);
        await running;
        await room.disconnect();
      },
    };
  };
}

/**
 * Feeds the loop to the source one frame at a time, wrapping at the end of the loop,
 * until `isStopped()` turns true. Each frame is a fresh copy (see the module comment).
 */
async function pump(
  source: AudioSource,
  samples: Int16Array,
  sampleRate: number,
  frameSamples: number,
  isStopped: () => boolean,
): Promise<void> {
  let offset = 0;
  while (!isStopped()) {
    const frame = new Int16Array(frameSamples);
    for (let i = 0; i < frameSamples; i++) frame[i] = samples[(offset + i) % samples.length]!;
    offset = (offset + frameSamples) % samples.length;
    try {
      await source.captureFrame(new AudioFrame(frame, sampleRate, 1, frameSamples));
    } catch {
      return; // the source was closed under us (room gone); the worker tears down
    }
  }
}
