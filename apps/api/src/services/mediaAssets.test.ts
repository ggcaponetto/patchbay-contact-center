/** Unit tests for the pure helpers of `mediaAssets.ts` (the database part is integration-tested). */
import { describe, expect, it } from 'vitest';
import { ALLOWED_MIME, MAX_ASSET_BYTES, isWav, mediaUrl } from './mediaAssets.ts';

describe('mediaAssets helpers', () => {
  it('sniffs RIFF/WAVE headers', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WAVE'),
      Buffer.from('fmt '),
    ]);
    expect(isWav(wav)).toBe(true);
    expect(isWav(Buffer.from('RIFF1234AVI '))).toBe(false);
    expect(isWav(Buffer.from('ID3'))).toBe(false);
    expect(isWav(Buffer.from('RIFF'))).toBe(false);
    expect(isWav(new Uint8Array(0))).toBe(false);
  });

  it('builds the public path and exposes the limits', () => {
    expect(mediaUrl('abc')).toBe('/api/public/media/abc');
    expect(MAX_ASSET_BYTES).toBe(5 * 1024 * 1024);
    expect(ALLOWED_MIME).toContain('audio/wav');
    expect(ALLOWED_MIME).toContain('audio/mpeg');
    expect(ALLOWED_MIME).not.toContain('image/png');
  });
});
