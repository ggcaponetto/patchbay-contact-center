/**
 * Stand-alone speech-to-text over raw LiveKit audio tracks.
 *
 * A `voice.AgentSession` only transcribes the participant it is talking to (the
 * customer). After a human agent joins, the desk still wants a transcript of everyone,
 * so `main.ts` starts this transcriber on the remaining tracks:
 *
 * - `leave` handoff: the session is closed; transcribe customer **and** human.
 * - `listen` handoff: the session keeps transcribing the customer; transcribe the human.
 *
 * Implementation: for every subscribed audio track that passes `include`, pull 16 kHz mono
 * frames with `AudioStream` from `@livekit/rtc-node`, push them into an `stt.stream()` and
 * forward final transcripts to `onSegment`. Interim results are ignored.
 *
 * @see apps/agent/README.md (section "Transcriber") for the limits of this approach.
 * @packageDocumentation
 */
import { stt } from '@livekit/agents';
import {
  AudioStream,
  type RemoteParticipant,
  type RemoteTrack,
  type Room,
  RoomEvent,
  TrackKind,
} from '@livekit/rtc-node';

/** Options for {@link startTranscriber}. */
export type TranscriberOptions = {
  /** The job's room; tracks are discovered through its events. */
  room: Room;
  /** Fresh STT instance per call to avoid sharing streams. */
  speechToText: stt.STT;
  /** Which remote participants to transcribe. */
  include: (p: RemoteParticipant) => boolean;
  /** Called once per final transcript with the speaking participant and its text. */
  onSegment: (participant: RemoteParticipant, text: string) => void;
};

/**
 * Transcribes the audio of selected remote participants (used after the human
 * handoff, when the AI session no longer covers the conversation).
 * Returns a function that stops everything.
 *
 * Existing tracks are picked up immediately; tracks published later are followed via
 * `TrackSubscribed` and released on `TrackUnsubscribed`. Each track gets its own STT
 * stream, keyed by track sid, so two people speaking at once are transcribed
 * independently.
 *
 * @returns A stop function that detaches the room listeners and closes every audio and
 *   STT stream. Always call it on shutdown.
 * @example
 * ```ts
 * const stop = startTranscriber({
 *   room: ctx.room,
 *   speechToText: new inference.STT({ model: 'assemblyai/universal-3-5-pro', language: 'en' }),
 *   include: (p) => p.attributes['role'] === 'human',
 *   onSegment: (p, text) => console.log(p.identity, text),
 * });
 * ctx.addShutdownCallback(async () => stop());
 * ```
 */
export function startTranscriber({
  room,
  speechToText,
  include,
  onSegment,
}: TranscriberOptions): () => void {
  const running = new Map<string, { stop: () => void }>();

  /** Starts an STT pipeline for one track, unless it is not audio, excluded or already running. */
  const follow = (track: RemoteTrack, participant: RemoteParticipant): void => {
    const sid = track.sid ?? '';
    if (track.kind !== TrackKind.KIND_AUDIO || !include(participant) || running.has(sid)) return;
    const speech = speechToText.stream();
    const audio = new AudioStream(track, { sampleRate: 16000, numChannels: 1 });
    let stopped = false;
    // Pump: audio frames -> STT stream. Ends the STT input when the track ends.
    void (async () => {
      for await (const frame of audio) {
        if (stopped) break;
        speech.pushFrame(frame);
      }
      speech.endInput();
    })();
    // Drain: STT events -> onSegment, final transcripts only.
    void (async () => {
      for await (const event of speech) {
        const text = event.alternatives?.[0]?.text?.trim();
        if (event.type === stt.SpeechEventType.FINAL_TRANSCRIPT && text)
          onSegment(participant, text);
      }
    })();
    running.set(sid, {
      stop: () => {
        stopped = true;
        audio.cancel();
        speech.close();
      },
    });
  };

  const onSubscribed = (track: RemoteTrack, _pub: unknown, participant: RemoteParticipant) =>
    follow(track, participant);
  const onUnsubscribed = (track: RemoteTrack) => {
    const sid = track.sid ?? '';
    running.get(sid)?.stop();
    running.delete(sid);
  };
  room.on(RoomEvent.TrackSubscribed, onSubscribed);
  room.on(RoomEvent.TrackUnsubscribed, onUnsubscribed);
  for (const p of room.remoteParticipants.values()) {
    for (const pub of p.trackPublications.values()) {
      if (pub.track) follow(pub.track as RemoteTrack, p);
    }
  }

  return () => {
    room.off(RoomEvent.TrackSubscribed, onSubscribed);
    room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed);
    for (const r of running.values()) r.stop();
    running.clear();
  };
}
