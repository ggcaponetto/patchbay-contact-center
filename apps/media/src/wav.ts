/**
 * Minimal WAV codec for the media worker: decode uploaded or linked hold-music files into
 * the 48 kHz mono 16-bit PCM the LiveKit transport publishes, and encode fixtures for
 * tests. No dependency — the RIFF/WAVE container is small enough to walk by hand.
 *
 * Supported input: `WAVE_FORMAT_PCM` (1) at 8 / 16 / 24 / 32 bits, `WAVE_FORMAT_IEEE_FLOAT`
 * (3) at 32 bits, and `WAVE_FORMAT_EXTENSIBLE` (0xFFFE) wrapping either. Anything else
 * (compressed WAV, MP3 bytes, truncated files) throws an `Error` whose message starts with
 * `wav:`, and the worker falls back to the synthesized loop.
 */

/** A decoded file: interleaved samples as 16-bit PCM, whatever the source format was. */
export type DecodedWav = { sampleRate: number; channels: number; samples: Int16Array };

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

const ascii = (view: DataView, offset: number, length: number): string => {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
};

/**
 * Decodes a RIFF/WAVE file.
 *
 * Walks the chunk list (chunks are word-aligned: an odd-sized chunk is followed by one
 * padding byte), reads `fmt ` and `data`, and converts every sample to 16-bit signed.
 *
 * @param buf - The whole file.
 * @throws Error `wav: …` when the file is not a WAV this worker can play.
 */
export function decodeWav(buf: ArrayBuffer | Uint8Array): DecodedWav {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') {
    throw new Error('wav: not a RIFF/WAVE file');
  }
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: { offset: number; length: number } | undefined;
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = ascii(view, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      if (size < 16) throw new Error('wav: fmt chunk too short');
      let format = view.getUint16(body, true);
      if (format === FORMAT_EXTENSIBLE) {
        // cbSize (16..17) + validBits (18..19) + channelMask (20..23) + GUID (24..39);
        // the first two GUID bytes are the real format code.
        if (size < 40) throw new Error('wav: extensible fmt chunk too short');
        format = view.getUint16(body + 24, true);
      }
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      // A streaming encoder may write 0xFFFFFFFF: take what is there.
      data = { offset: body, length: Math.min(size, bytes.byteLength - body) };
    }
    pos = body + size + (size % 2);
  }
  if (!fmt) throw new Error('wav: missing fmt chunk');
  if (!data) throw new Error('wav: missing data chunk');
  const { format, channels, sampleRate, bits } = fmt;
  if (channels < 1 || sampleRate < 1) throw new Error('wav: invalid channel count or sample rate');
  const pcmBits = format === FORMAT_PCM && [8, 16, 24, 32].includes(bits);
  const floatBits = format === FORMAT_FLOAT && bits === 32;
  if (!pcmBits && !floatBits) throw new Error(`wav: unsupported format ${format} / ${bits}-bit`);
  const bytesPer = bits / 8;
  const count = Math.floor(data.length / bytesPer);
  const samples = new Int16Array(count);
  const base = data.offset;
  for (let i = 0; i < count; i++) {
    const at = base + i * bytesPer;
    let v: number;
    if (floatBits) {
      v = Math.max(-1, Math.min(1, view.getFloat32(at, true))) * 32767;
    } else if (bits === 8) {
      v = (view.getUint8(at) - 128) << 8; // 8-bit WAV is unsigned
    } else if (bits === 16) {
      v = view.getInt16(at, true);
    } else if (bits === 24) {
      v = view.getInt16(at + 1, true); // the top two of three bytes (little-endian)
    } else {
      v = view.getInt32(at, true) >> 16;
    }
    samples[i] = Math.round(v);
  }
  return { sampleRate, channels, samples };
}

/**
 * Mixes a decoded file down to mono and resamples it (linear interpolation) to
 * `targetRate`. Returns the input samples untouched when nothing needs to change.
 *
 * @param pcm - Decoded file (interleaved channels).
 * @param targetRate - Output sample rate (default 48 000, what LiveKit publishes).
 */
export function toMono48k(pcm: DecodedWav, targetRate = 48_000): Int16Array {
  const { channels, sampleRate, samples } = pcm;
  if (channels === 1 && sampleRate === targetRate) return samples;
  const frames = Math.floor(samples.length / channels);
  let mono: Int16Array;
  if (channels === 1) {
    mono = samples;
  } else {
    mono = new Int16Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += samples[f * channels + c]!;
      mono[f] = Math.round(sum / channels);
    }
  }
  if (sampleRate === targetRate) return mono;
  const outLength = Math.max(1, Math.round((frames * targetRate) / sampleRate));
  const out = new Int16Array(outLength);
  const step = sampleRate / targetRate;
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * step;
    const i0 = Math.min(frames - 1, Math.floor(srcPos));
    const i1 = Math.min(frames - 1, i0 + 1);
    const frac = srcPos - i0;
    out[i] = Math.round(mono[i0]! * (1 - frac) + mono[i1]! * frac);
  }
  return out;
}

/**
 * Encodes 16-bit PCM as a canonical 44-byte-header WAV (tests and fixtures).
 *
 * @param samples - Interleaved samples.
 * @param sampleRate - Samples per second per channel.
 * @param channels - Channel count (default 1).
 */
export function encodeWav(samples: Int16Array, sampleRate: number, channels = 1): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const tag = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return out;
}
