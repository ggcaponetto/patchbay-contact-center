/**
 * The media worker's logic, separated from the process entrypoint so it can be tested
 * with fakes: listens for {@link MediaCommand}s on the Postgres bus channel (`cc_bus`,
 * the same channel the API instances use) and keeps one music-on-hold session per call.
 *
 * `moh.start` joins the call's LiveKit room with the token minted by the API (identity
 * `media:<callId>`) and publishes the hold-music loop — the configured file when the
 * command carries a `music` URL (`loops.ts`), else the synthesized loop from `music.ts`;
 * `moh.stop` disconnects. A session also ends by itself when the room is deleted (call ended). The
 * worker is stateless across restarts: a lost session simply means the music stops, and
 * the next hold starts a fresh one.
 */
import { MediaCommand } from '@cc/shared';
import { type MusicStyle, SAMPLE_RATE } from './music.ts';

/** 10 ms of audio per frame, the granularity LiveKit expects. */
const FRAME_SAMPLES = SAMPLE_RATE / 100;

/** One live music session: stop tears everything down. */
export type Session = { stop(): Promise<void> };

/**
 * How the worker touches the outside world; `index.ts` passes the real implementations,
 * tests pass fakes.
 */
export type WorkerDeps = {
  /** Joins the room and returns a way to push audio frames + leave. */
  connect(
    url: string,
    token: string,
  ): Promise<{
    publish(samples: Int16Array, sampleRate: number, frameSamples: number): Promise<void>;
    disconnect(): Promise<void>;
    /** Called by the transport when the room goes away (call ended). */
    onClosed(handler: () => void): void;
  }>;
  log(message: string): void;
  /**
   * The loop to play: the file at `music` when set and usable, else the synthesized
   * `style` loop (`createLoopCache` in `loops.ts`). Resolved before joining the room.
   */
  resolveLoop(music: string | undefined, style: MusicStyle): Promise<Int16Array>;
};

/**
 * Creates the command handler. Feed it every bus payload; non-media messages are
 * ignored, malformed media commands are logged and dropped.
 *
 * @returns `handle` for raw bus payloads and `close` to stop every session.
 */
export function createWorker(deps: WorkerDeps) {
  const sessions = new Map<string, Session>();

  const start = async (cmd: Extract<MediaCommand, { action: 'moh.start' }>) => {
    if (sessions.has(cmd.callId)) return;
    // Register before connecting: a `moh.stop` can arrive while the room is still being
    // joined (the desk sees the participant before our own connect promise resolves).
    const state = { cancelled: false, disconnect: async () => undefined as void | Promise<void> };
    const session: Session = {
      stop: async () => {
        state.cancelled = true;
        sessions.delete(cmd.callId);
        await state.disconnect();
      },
    };
    sessions.set(cmd.callId, session);
    // Decode (or fetch) the music first so the customer never joins a silent room.
    const style = cmd.style ?? 'calm';
    const loop = await deps.resolveLoop(cmd.music, style);
    if (state.cancelled) return;
    const room = await deps.connect(cmd.url, cmd.token);
    state.disconnect = () => room.disconnect();
    if (state.cancelled) {
      await room.disconnect();
      return;
    }
    room.onClosed(() => void session.stop());
    // The room may already be gone (a `moh.stop` raced the join and the room was deleted,
    // or `onClosed` fired synchronously): never publish into a disconnected room.
    if (state.cancelled) return;
    deps.log(`moh started for ${cmd.callId} in ${cmd.roomName} (${cmd.music ?? style})`);
    await room.publish(loop, SAMPLE_RATE, FRAME_SAMPLES);
  };

  return {
    /** Handles one raw bus payload (JSON string). */
    async handle(raw: string): Promise<void> {
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (typeof message !== 'object' || message === null) return;
      if ((message as { kind?: string }).kind !== 'media') return;
      const parsed = MediaCommand.safeParse((message as { command?: unknown }).command);
      if (!parsed.success) {
        deps.log(`dropped malformed media command`);
        return;
      }
      const cmd = parsed.data;
      if (cmd.action === 'moh.start') {
        await start(cmd).catch((err) => {
          sessions.delete(cmd.callId);
          deps.log(`moh failed for ${cmd.callId}: ${err}`);
        });
      } else {
        await sessions.get(cmd.callId)?.stop();
        deps.log(`moh stopped for ${cmd.callId}`);
      }
    },
    /** Number of live sessions (tests, shutdown logging). */
    size: () => sessions.size,
    /** Stops every session (process shutdown). */
    async close(): Promise<void> {
      await Promise.all([...sessions.values()].map((s) => s.stop()));
    },
  };
}
