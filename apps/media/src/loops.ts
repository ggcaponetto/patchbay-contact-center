/**
 * Hold-music loop resolution for the media worker: a `moh.start` command may carry a
 * `music` URL (an uploaded file under `/api/public/media/…` or any `http(s)` URL); this
 * module fetches and decodes it once, keeps a small LRU of decoded loops, and falls back
 * to the synthesized `renderLoop(style)` whenever the file cannot be used — so a bad
 * upload never leaves a held customer in silence.
 */
import { type MusicStyle, SAMPLE_RATE, renderLoop } from './music.ts';
import { decodeWav, toMono48k } from './wav.ts';

/** Largest file the worker downloads (the API caps uploads at 5 MiB; links may be bigger). */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** Shortest usable loop: one 10 ms LiveKit frame. */
const MIN_LOOP_SAMPLES = SAMPLE_RATE / 100;

/** What {@link createLoopCache} needs from the outside. */
export type LoopCacheDeps = {
  /** `globalThis.fetch` in production, a fake in tests. */
  fetch: (url: string) => Promise<{
    ok: boolean;
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  /** Where relative `/api/public/media/…` paths live. */
  apiOrigin: string;
  log(message: string): void;
  /** Decoded loops kept in memory (LRU); default 8. */
  maxEntries?: number;
};

/**
 * Turns a configured sound URL into an absolute one: relative paths are resolved against
 * the API origin, absolute URLs are returned as they are.
 */
export const resolveMusicUrl = (url: string, apiOrigin: string): string =>
  /^https?:\/\//i.test(url) ? url : `${apiOrigin.replace(/\/$/, '')}${url}`;

/**
 * Creates the loop resolver the worker passes as `resolveLoop`: `get(music, style)`
 * returns the decoded file for `music` (fetched once per URL) or the synthesized loop
 * for `style` when there is no file or it is unusable (non-2xx, too large, not a WAV the
 * worker can decode, shorter than one frame).
 */
export function createLoopCache({ fetch, apiOrigin, log, maxEntries = 8 }: LoopCacheDeps) {
  const loops = new Map<MusicStyle, Int16Array>();
  const files = new Map<string, Promise<Int16Array | undefined>>();

  const synthesized = (style: MusicStyle) => {
    let loop = loops.get(style);
    if (!loop) {
      loop = renderLoop(style);
      loops.set(style, loop);
    }
    return loop;
  };

  const download = async (music: string): Promise<Int16Array | undefined> => {
    const url = resolveMusicUrl(music, apiOrigin);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error('file too large');
      const samples = toMono48k(decodeWav(bytes));
      if (samples.length < MIN_LOOP_SAMPLES) throw new Error('file too short');
      return samples;
    } catch (err) {
      log(`hold music ${url} unusable (${(err as Error).message}); using synthesized loop`);
      return undefined;
    }
  };

  return {
    /** The loop to publish: the file at `music` when usable, else the `style` loop. */
    async get(music: string | undefined, style: MusicStyle = 'calm'): Promise<Int16Array> {
      if (!music) return synthesized(style);
      let pending = files.get(music);
      if (pending) {
        // LRU: re-insert as the most recent entry.
        files.delete(music);
      } else {
        pending = download(music);
      }
      files.set(music, pending);
      while (files.size > maxEntries) files.delete(files.keys().next().value!);
      const decoded = await pending;
      if (decoded) return decoded;
      // Do not cache the failure: the file may be fixed before the next hold.
      files.delete(music);
      return synthesized(style);
    },
    /** Cached file URLs, most recent last (tests). */
    keys: () => [...files.keys()],
  };
}
