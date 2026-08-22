/**
 * Unit tests for `startTranscriber`: `@livekit/rtc-node` is mocked (no native binding),
 * the room is an `EventEmitter`, and the STT is a fake whose stream is fed by the test.
 */
import { stt } from '@livekit/agents';
import type { RemoteParticipant, RemoteTrack, Room } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { startTranscriber } from './transcriber.ts';

// String values are arbitrary: the module under test imports the same mock.
vi.mock('@livekit/rtc-node', () => ({
  RoomEvent: { TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed' },
  TrackKind: { KIND_AUDIO: 1, KIND_VIDEO: 2 },
  AudioStream: class FakeAudioStream {
    static instances: FakeAudioStream[] = [];
    cancel = vi.fn(() => this.done());
    private done: () => void = () => undefined;
    private frames: unknown[];
    constructor(track: { frames?: unknown[] }) {
      this.frames = track.frames ?? [];
      FakeAudioStream.instances.push(this);
    }
    async *[Symbol.asyncIterator]() {
      yield* this.frames;
      // Stay open until cancelled, like a live track.
      await new Promise<void>((resolve) => (this.done = resolve));
    }
  },
}));

/** Deferred queue: the test pushes STT events, the transcriber's drain loop consumes them. */
class FakeSpeechStream {
  pushFrame = vi.fn();
  endInput = vi.fn();
  close = vi.fn(() => this.push(undefined));
  private queue: (stt.SpeechEvent | undefined)[] = [];
  private wake: (() => void) | undefined;
  push(event: stt.SpeechEvent | undefined) {
    this.queue.push(event);
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.queue.length === 0) await new Promise<void>((r) => (this.wake = r));
      const event = this.queue.shift();
      if (event === undefined) return;
      yield event;
    }
  }
}

const participant = (identity: string, tracks: (RemoteTrack | undefined)[] = []) =>
  ({
    identity,
    attributes: {},
    // `undefined` models a publication whose track is not subscribed yet.
    trackPublications: new Map(tracks.map((t, i) => [`pub${i}`, { track: t }])),
  }) as unknown as RemoteParticipant;

const track = (sid: string, kind = 1, frames: unknown[] = []) =>
  ({ sid, kind, frames }) as unknown as RemoteTrack;

const setup = (participants: RemoteParticipant[] = []) => {
  const room = Object.assign(new EventEmitter(), {
    remoteParticipants: new Map(participants.map((p) => [p.identity, p])),
  }) as unknown as Room;
  const streams: FakeSpeechStream[] = [];
  const speechToText = {
    stream: vi.fn(() => {
      const s = new FakeSpeechStream();
      streams.push(s);
      return s;
    }),
  } as unknown as stt.STT;
  const onSegment = vi.fn();
  const include = vi.fn((p: RemoteParticipant) => p.identity !== 'excluded');
  return { room, streams, speechToText, onSegment, include };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('startTranscriber', () => {
  it('transcribes existing audio tracks and forwards only final transcripts', async () => {
    const human = participant('human', [track('t1', 1, ['f1', 'f2']), track('v1', 2), undefined]);
    const { room, streams, speechToText, onSegment, include } = setup([human]);
    const stop = startTranscriber({ room, speechToText, include, onSegment });
    expect(speechToText.stream).toHaveBeenCalledTimes(1);
    await tick();
    expect(streams[0]!.pushFrame.mock.calls.map((c) => c[0])).toEqual(['f1', 'f2']);
    expect(streams[0]!.endInput).not.toHaveBeenCalled();

    streams[0]!.push({
      type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
      alternatives: [{ text: 'hel' }],
    } as stt.SpeechEvent);
    streams[0]!.push({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text: '  hello there ' }],
    } as stt.SpeechEvent);
    streams[0]!.push({ type: stt.SpeechEventType.FINAL_TRANSCRIPT } as stt.SpeechEvent);
    streams[0]!.push({
      type: stt.SpeechEventType.FINAL_TRANSCRIPT,
      alternatives: [{ text: '   ' }],
    } as stt.SpeechEvent);
    await tick();
    expect(onSegment).toHaveBeenCalledTimes(1);
    expect(onSegment).toHaveBeenCalledWith(human, 'hello there');

    stop();
    expect(streams[0]!.close).toHaveBeenCalledTimes(1);
    await tick();
    // The audio pump ended through cancel(), so the STT input was closed.
    expect(streams[0]!.endInput).toHaveBeenCalledTimes(1);
  });

  it('follows tracks subscribed later, ignores excluded participants and duplicates', async () => {
    const { room, speechToText, onSegment, include } = setup();
    const stop = startTranscriber({ room, speechToText, include, onSegment });
    const human = participant('human');
    const other = participant('excluded');
    const emitter = room as unknown as EventEmitter;
    emitter.emit('trackSubscribed', track('a1'), {}, human);
    emitter.emit('trackSubscribed', track('a1'), {}, human); // same sid: ignored
    emitter.emit('trackSubscribed', track('a2'), {}, other); // excluded
    emitter.emit('trackSubscribed', track('a3', 2), {}, human); // video
    emitter.emit('trackSubscribed', { kind: 1 } as RemoteTrack, {}, human); // no sid -> ''
    expect(speechToText.stream).toHaveBeenCalledTimes(2);
    expect(include).toHaveBeenCalledWith(other);
    stop();
  });

  it('stops a stream on unsubscribe and everything on stop()', async () => {
    const { room, streams, speechToText, onSegment, include } = setup();
    const stop = startTranscriber({ room, speechToText, include, onSegment });
    const human = participant('human');
    const emitter = room as unknown as EventEmitter;
    emitter.emit('trackSubscribed', track('a1'), {}, human);
    emitter.emit('trackSubscribed', track('a2'), {}, human);
    emitter.emit('trackUnsubscribed', track('a1'));
    emitter.emit('trackUnsubscribed', track('unknown'));
    emitter.emit('trackUnsubscribed', {} as RemoteTrack);
    expect(streams[0]!.close).toHaveBeenCalledTimes(1);
    expect(streams[1]!.close).not.toHaveBeenCalled();
    // Re-subscribing the same sid starts a new stream after it was released.
    emitter.emit('trackSubscribed', track('a1'), {}, human);
    expect(speechToText.stream).toHaveBeenCalledTimes(3);

    stop();
    expect(streams[1]!.close).toHaveBeenCalledTimes(1);
    expect(streams[2]!.close).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount('trackSubscribed')).toBe(0);
    expect(emitter.listenerCount('trackUnsubscribed')).toBe(0);
    // After stop nothing new is followed.
    emitter.emit('trackSubscribed', track('a9'), {}, human);
    expect(speechToText.stream).toHaveBeenCalledTimes(3);
  });

  it('drops frames that arrive after stop', async () => {
    const { room, streams, speechToText, onSegment, include } = setup();
    const stop = startTranscriber({ room, speechToText, include, onSegment });
    const emitter = room as unknown as EventEmitter;
    // Frames are yielded synchronously-ish by the fake; stop before the pump runs so the
    // `stopped` guard is what ends the loop.
    emitter.emit('trackSubscribed', track('a1', 1, ['f1', 'f2']), {}, participant('human'));
    stop();
    await tick();
    expect(streams[0]!.pushFrame).not.toHaveBeenCalled();
    expect(streams[0]!.endInput).toHaveBeenCalledTimes(1);
  });
});
