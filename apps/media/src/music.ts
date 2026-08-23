/**
 * Synthesized music on hold: a soft, slowly arpeggiated A-major-pentatonic loop rendered
 * to 16-bit PCM. No audio assets to ship or license — the loop is computed once at
 * startup and pushed to the room frame by frame by `worker.ts`.
 */

/** Samples per second of the generated loop (what LiveKit's `AudioSource` expects). */
export const SAMPLE_RATE = 48_000;

/** Note sets (Hz) per style: `calm` is a low A-major pentatonic arpeggio, `bright` a
 * quicker, higher D-major one (queues pick a style via `QueueConfig.moh`). */
const STYLES = {
  calm: {
    notes: [220, 246.94, 277.18, 329.63, 369.99, 440, 369.99, 329.63, 277.18, 246.94],
    noteSec: 0.8,
  },
  bright: {
    notes: [293.66, 329.63, 369.99, 440, 493.88, 587.33, 493.88, 440, 369.99, 329.63],
    noteSec: 0.5,
  },
} as const;

/** The available hold-music styles. */
export type MusicStyle = keyof typeof STYLES;

/**
 * Renders the loop of one style. Each note is a sine with a softer octave overtone, an
 * attack/release envelope so notes never click, and a low overall volume (hold music
 * sits in the background). Deterministic: same output every call.
 *
 * @param style - Which note set to render, see {@link MusicStyle} (default `calm`).
 * @param volume - Peak amplitude, 0..1 (default 0.18).
 * @returns Mono 16-bit samples at {@link SAMPLE_RATE}.
 */
export function renderLoop(style: MusicStyle = 'calm', volume = 0.18): Int16Array {
  const { notes: NOTES, noteSec: NOTE_SEC } = STYLES[style];
  const perNote = Math.round(SAMPLE_RATE * NOTE_SEC);
  const samples = new Int16Array(perNote * NOTES.length);
  const attack = Math.round(SAMPLE_RATE * 0.05);
  const release = Math.round(SAMPLE_RATE * 0.35);
  for (let n = 0; n < NOTES.length; n++) {
    const f = NOTES[n]!;
    for (let i = 0; i < perNote; i++) {
      const t = i / SAMPLE_RATE;
      const envelope =
        i < attack ? i / attack : i > perNote - release ? (perNote - i) / release : 1;
      const value = Math.sin(2 * Math.PI * f * t) * 0.8 + Math.sin(2 * Math.PI * f * 2 * t) * 0.2;
      samples[n * perNote + i] = Math.round(value * envelope * volume * 32767);
    }
  }
  return samples;
}
