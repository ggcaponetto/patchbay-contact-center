/**
 * Tests for the WAV codec: round trips through `encodeWav`, every supported sample
 * format (built by hand), chunk walking with padding and unknown chunks, the mono /
 * resampling step, and the error paths.
 */
import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav, toMono48k } from './wav.ts';

/** Builds a WAV with an arbitrary `fmt ` chunk (and optional extra chunks) around raw sample bytes. */
const wavWith = (
  fmt: { format: number; channels: number; sampleRate: number; bits: number; extensible?: boolean },
  data: Uint8Array,
  extraChunks: { id: string; body: Uint8Array }[] = [],
): Uint8Array => {
  const fmtSize = fmt.extensible ? 40 : 16;
  const chunks: Uint8Array[] = [];
  const chunk = (id: string, body: Uint8Array) => {
    const padded = body.length % 2 ? body.length + 1 : body.length;
    const out = new Uint8Array(8 + padded);
    for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  };
  const fmtBody = new Uint8Array(fmtSize);
  const v = new DataView(fmtBody.buffer);
  v.setUint16(0, fmt.extensible ? 0xfffe : fmt.format, true);
  v.setUint16(2, fmt.channels, true);
  v.setUint32(4, fmt.sampleRate, true);
  v.setUint32(8, (fmt.sampleRate * fmt.channels * fmt.bits) / 8, true);
  v.setUint16(12, (fmt.channels * fmt.bits) / 8, true);
  v.setUint16(14, fmt.bits, true);
  if (fmt.extensible) {
    v.setUint16(16, 22, true);
    v.setUint16(18, fmt.bits, true);
    v.setUint32(20, 0, true);
    v.setUint16(24, fmt.format, true);
  }
  chunks.push(chunk('fmt ', fmtBody));
  for (const c of extraChunks) chunks.push(chunk(c.id, c.body));
  chunks.push(chunk('data', data));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + total);
  for (let i = 0; i < 4; i++) out[i] = 'RIFF'.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, 4 + total, true);
  for (let i = 0; i < 4; i++) out[8 + i] = 'WAVE'.charCodeAt(i);
  let pos = 12;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
};

describe('encodeWav / decodeWav', () => {
  it('round-trips 16-bit mono and stereo', () => {
    const mono = Int16Array.from([0, 1000, -1000, 32767, -32768]);
    const file = encodeWav(mono, 8000);
    expect(file.length).toBe(44 + 10);
    expect(decodeWav(file)).toEqual({ sampleRate: 8000, channels: 1, samples: mono });
    const stereo = Int16Array.from([1, 2, 3, 4]);
    expect(decodeWav(encodeWav(stereo, 44100, 2).buffer as ArrayBuffer)).toEqual({
      sampleRate: 44100,
      channels: 2,
      samples: stereo,
    });
  });

  it('decodes 8, 24 and 32-bit PCM and 32-bit float, plain or extensible', () => {
    const u8 = wavWith(
      { format: 1, channels: 1, sampleRate: 8000, bits: 8 },
      Uint8Array.from([128, 255, 0]),
    );
    expect([...decodeWav(u8).samples]).toEqual([0, 127 << 8, -128 << 8]);

    const b24 = new Uint8Array(6);
    const d24 = new DataView(b24.buffer);
    d24.setUint8(0, 0xff); // low byte ignored
    d24.setInt16(1, 1234, true);
    d24.setUint8(3, 0);
    d24.setInt16(4, -4321, true);
    expect([
      ...decodeWav(wavWith({ format: 1, channels: 1, sampleRate: 8000, bits: 24 }, b24)).samples,
    ]).toEqual([1234, -4321]);

    const b32 = new Uint8Array(8);
    const d32 = new DataView(b32.buffer);
    d32.setInt32(0, 1234 << 16, true);
    d32.setInt32(4, -5 << 16, true);
    expect([
      ...decodeWav(wavWith({ format: 1, channels: 1, sampleRate: 8000, bits: 32 }, b32)).samples,
    ]).toEqual([1234, -5]);

    const f32 = new Uint8Array(16);
    const df = new DataView(f32.buffer);
    df.setFloat32(0, 0.5, true);
    df.setFloat32(4, -1, true);
    df.setFloat32(8, 2, true); // clipped
    df.setFloat32(12, 0, true);
    const float = decodeWav(wavWith({ format: 3, channels: 2, sampleRate: 48000, bits: 32 }, f32));
    expect(float.channels).toBe(2);
    expect([...float.samples]).toEqual([16384, -32767, 32767, 0]);
    const ext = decodeWav(
      wavWith({ format: 3, channels: 1, sampleRate: 48000, bits: 32, extensible: true }, f32),
    );
    expect([...ext.samples]).toEqual([16384, -32767, 32767, 0]);
  });

  it('walks unknown and odd-sized chunks and tolerates a streaming data size', () => {
    const data = new Uint8Array([0x10, 0x00, 0x20, 0x00]);
    const file = wavWith({ format: 1, channels: 1, sampleRate: 8000, bits: 16 }, data, [
      { id: 'LIST', body: Uint8Array.from([1, 2, 3]) }, // odd size: padded to 4
      { id: 'junk', body: new Uint8Array(0) },
    ]);
    expect([...decodeWav(file).samples]).toEqual([16, 32]);
    // a data chunk claiming more than the file has: decode what is there
    const view = new DataView(file.buffer);
    view.setUint32(file.length - 8, 0xffffffff, true);
    expect([...decodeWav(file).samples]).toEqual([16, 32]);
  });

  it('throws `wav:` errors for everything else', () => {
    const pcm = (bits: number, format = 1) =>
      wavWith({ format, channels: 1, sampleRate: 8000, bits }, new Uint8Array(4));
    expect(() => decodeWav(new Uint8Array([1, 2, 3]))).toThrow(/^wav: not a RIFF/);
    expect(() => decodeWav(new TextEncoder().encode('ID3 not a wav at all'))).toThrow(/^wav:/);
    expect(() => decodeWav(pcm(12))).toThrow(/^wav: unsupported format 1 \/ 12-bit/);
    expect(() => decodeWav(pcm(16, 3))).toThrow(/^wav: unsupported/);
    expect(() => decodeWav(pcm(16, 85))).toThrow(/^wav: unsupported format 85/); // MP3-in-WAV
    expect(() =>
      decodeWav(wavWith({ format: 1, channels: 0, sampleRate: 8000, bits: 16 }, new Uint8Array(2))),
    ).toThrow(/^wav: invalid channel/);
    const noData = encodeWav(new Int16Array(0), 8000).subarray(0, 36);
    expect(() => decodeWav(noData)).toThrow(/^wav: missing data/);
    const noFmt = new Uint8Array(20);
    noFmt.set(new TextEncoder().encode('RIFF'), 0);
    noFmt.set(new TextEncoder().encode('WAVE'), 8);
    noFmt.set(new TextEncoder().encode('data'), 12);
    expect(() => decodeWav(noFmt)).toThrow(/^wav: missing fmt/);
    const shortFmt = wavWith(
      { format: 1, channels: 1, sampleRate: 8000, bits: 16 },
      new Uint8Array(2),
    );
    new DataView(shortFmt.buffer).setUint32(16, 8, true);
    expect(() => decodeWav(shortFmt)).toThrow(/^wav: fmt chunk too short/);
    const shortExt = wavWith(
      { format: 1, channels: 1, sampleRate: 8000, bits: 16 },
      new Uint8Array(2),
    );
    new DataView(shortExt.buffer).setUint16(20, 0xfffe, true);
    expect(() => decodeWav(shortExt)).toThrow(/^wav: extensible fmt chunk too short/);
  });
});

describe('toMono48k', () => {
  it('returns the input untouched when already mono at the target rate', () => {
    const samples = Int16Array.from([1, 2, 3]);
    expect(toMono48k({ sampleRate: 48000, channels: 1, samples })).toBe(samples);
  });

  it('averages channels', () => {
    const out = toMono48k({
      sampleRate: 48000,
      channels: 2,
      samples: Int16Array.from([100, 300, -10, 10, 7]),
    });
    expect([...out]).toEqual([200, 0]); // the trailing half-frame is dropped
  });

  it('resamples linearly up and down', () => {
    const up = toMono48k({
      sampleRate: 24000,
      channels: 1,
      samples: Int16Array.from([0, 100, 200, 300]),
    });
    expect(up.length).toBe(8);
    expect([...up]).toEqual([0, 50, 100, 150, 200, 250, 300, 300]);
    const down = toMono48k({
      sampleRate: 96000,
      channels: 1,
      samples: Int16Array.from([0, 10, 20, 30]),
    });
    expect([...down]).toEqual([0, 20]);
    const stereo = toMono48k({
      sampleRate: 24000,
      channels: 2,
      samples: Int16Array.from([0, 0, 100, 100]),
    });
    expect([...stereo]).toEqual([0, 50, 100, 100]);
    // 1 s of 8 kHz → 1 s of 48 kHz
    expect(toMono48k({ sampleRate: 8000, channels: 1, samples: new Int16Array(8000) }).length).toBe(
      48000,
    );
  });
});
