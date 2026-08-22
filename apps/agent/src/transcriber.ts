import { stt } from '@livekit/agents';
import {
  AudioStream,
  type RemoteParticipant,
  type RemoteTrack,
  type Room,
  RoomEvent,
  TrackKind,
} from '@livekit/rtc-node';

export type TranscriberOptions = {
  room: Room;
  /** Fresh STT instance per call to avoid sharing streams. */
  speechToText: stt.STT;
  /** Which remote participants to transcribe. */
  include: (p: RemoteParticipant) => boolean;
  onSegment: (participant: RemoteParticipant, text: string) => void;
};

/**
 * Transcribes the audio of selected remote participants (used after the human
 * handoff, when the AI session no longer covers the conversation).
 * Returns a function that stops everything.
 */
export function startTranscriber({
  room,
  speechToText,
  include,
  onSegment,
}: TranscriberOptions): () => void {
  const running = new Map<string, { stop: () => void }>();

  const follow = (track: RemoteTrack, participant: RemoteParticipant): void => {
    const sid = track.sid ?? '';
    if (track.kind !== TrackKind.KIND_AUDIO || !include(participant) || running.has(sid)) return;
    const speech = speechToText.stream();
    const audio = new AudioStream(track, { sampleRate: 16000, numChannels: 1 });
    let stopped = false;
    void (async () => {
      for await (const frame of audio) {
        if (stopped) break;
        speech.pushFrame(frame);
      }
      speech.endInput();
    })();
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
