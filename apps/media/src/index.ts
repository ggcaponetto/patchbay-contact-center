/**
 * Process entrypoint of the media worker (`npm run dev:media`): loads `.env.local`,
 * subscribes to the Postgres bus channel and hands every notification to the worker in
 * `worker.ts`. The LiveKit transport lives here (`@livekit/rtc-node`): join a room with
 * the token from the command, publish the hold-music loop until disconnected.
 *
 * Nothing else lives here on purpose, so the logic stays testable with fakes.
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
import dotenv from 'dotenv';
import pg from 'pg';
import { createWorker } from './worker.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });

const worker = createWorker({
  log: (m) => console.log(`media: ${m}`),
  async connect(url, token) {
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
  },
});

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? '' });
await client.connect();
client.on('notification', (n) => {
  if (n.channel === 'cc_bus' && n.payload) void worker.handle(n.payload);
});
await client.query('LISTEN cc_bus');
console.log('media: worker listening for hold-music commands');

const shutdown = async () => {
  await worker.close();
  await client.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
