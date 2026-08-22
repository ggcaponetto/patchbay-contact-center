/**
 * The LiveKit side of the media worker: joins a room with the token from a
 * {@link MediaCommand} and pushes the hold-music loop as one 10 ms `AudioFrame` per
 * tick until disconnected. This is the `connect` dependency of `worker.ts`, kept in its
 * own module so it can be unit-tested with a mocked `@livekit/rtc-node`.
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
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed: () => void = () => undefined;
    room.on(RoomEvent.Disconnected, () => closed());
    return {
      onClosed: (handler) => {
        closed = handler;
      },
      async publish(samples, sampleRate, frameSamples) {
        const source = new AudioSource(sampleRate, 1);
        const track = LocalAudioTrack.createAudioTrack('moh', source);
        const options = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
        await room.localParticipant?.publishTrack(track, options);
        // Push one 10 ms frame per tick, looping over the rendered melody forever.
        let offset = 0;
        timer = setInterval(() => {
          const frame = new AudioFrame(
            samples.subarray(offset, offset + frameSamples),
            sampleRate,
            1,
            frameSamples,
          );
          offset = (offset + frameSamples) % (samples.length - frameSamples);
          void source.captureFrame(frame);
        }, 10);
      },
      async disconnect() {
        if (timer) clearInterval(timer);
        await room.disconnect();
      },
    };
  };
}
