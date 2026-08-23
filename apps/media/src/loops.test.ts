/**
 * Tests for the hold-music loop cache with a fake `fetch`: URL resolution, fetch-once
 * per file, LRU eviction, the rejection rules and the synthesized fallback.
 */
import { describe, expect, it, vi } from 'vitest';
import { MAX_DOWNLOAD_BYTES, createLoopCache, resolveMusicUrl } from './loops.ts';
import { SAMPLE_RATE, renderLoop } from './music.ts';
import { encodeWav } from './wav.ts';

const response = (body: Uint8Array | ArrayBuffer, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  arrayBuffer: async () =>
    body instanceof Uint8Array
      ? (body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer)
      : body,
});

describe('resolveMusicUrl', () => {
  it('keeps absolute URLs and prefixes relative paths with the API origin', () => {
    expect(resolveMusicUrl('https://cdn.example.com/a.wav', 'http://api')).toBe(
      'https://cdn.example.com/a.wav',
    );
    expect(resolveMusicUrl('HTTP://x/y', 'http://api')).toBe('HTTP://x/y');
    expect(resolveMusicUrl('/api/public/media/m1', 'http://localhost:4000/')).toBe(
      'http://localhost:4000/api/public/media/m1',
    );
  });
});

describe('createLoopCache', () => {
  const good = encodeWav(new Int16Array(SAMPLE_RATE).fill(100), SAMPLE_RATE);
  const make = (files: Record<string, ReturnType<typeof response>>, maxEntries?: number) => {
    const fetch = vi.fn(async (url: string) => files[url] ?? response(new Uint8Array(0), 404));
    const log = vi.fn();
    const cache = createLoopCache({
      fetch,
      apiOrigin: 'http://api',
      log,
      ...(maxEntries ? { maxEntries } : {}),
    });
    return { cache, fetch, log };
  };

  it('plays the synthesized style without a file, and a decoded file once fetched', async () => {
    const { cache, fetch, log } = make({ 'http://api/api/public/media/m1': response(good) });
    expect(await cache.get(undefined, 'bright')).toEqual(renderLoop('bright'));
    expect(await cache.get(undefined, 'calm')).toBe(await cache.get(undefined, 'calm'));
    expect(fetch).not.toHaveBeenCalled();

    const loop = await cache.get('/api/public/media/m1', 'calm');
    expect(loop.length).toBe(SAMPLE_RATE);
    expect(loop[0]).toBe(100);
    expect(await cache.get('/api/public/media/m1', 'calm')).toBe(loop);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('http://api/api/public/media/m1');
    expect(log).not.toHaveBeenCalled();
  });

  it('fetches concurrent requests for the same file once', async () => {
    const { cache, fetch } = make({ 'http://api/a': response(good) });
    const [a, b] = await Promise.all([cache.get('/a'), cache.get('/a')]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to the style loop (with a log line) and does not cache failures', async () => {
    const tiny = encodeWav(new Int16Array(100), SAMPLE_RATE);
    const { cache, fetch, log } = make({
      'https://x/404.wav': response(new Uint8Array(0), 404),
      'https://x/mp3.wav': response(new TextEncoder().encode('ID3 definitely not wav')),
      'https://x/big.wav': response(new ArrayBuffer(MAX_DOWNLOAD_BYTES + 1)),
      'https://x/tiny.wav': response(tiny),
    });
    for (const [url, reason] of [
      ['https://x/404.wav', 'HTTP 404'],
      ['https://x/mp3.wav', 'wav: not a RIFF/WAVE file'],
      ['https://x/big.wav', 'file too large'],
      ['https://x/tiny.wav', 'file too short'],
    ] as const) {
      expect(await cache.get(url, 'bright')).toEqual(renderLoop('bright'));
      expect(log).toHaveBeenLastCalledWith(
        `hold music ${url} unusable (${reason}); using synthesized loop`,
      );
    }
    expect(cache.keys()).toEqual([]);
    // a failed URL is retried next time
    await cache.get('https://x/404.wav');
    expect(fetch).toHaveBeenCalledTimes(5);
    // a throwing fetch is a fallback too
    fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await cache.get('https://x/down.wav', 'calm')).toEqual(renderLoop('calm'));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('keeps at most `maxEntries` files, evicting the least recently used', async () => {
    const { cache, fetch } = make(
      {
        'http://api/a': response(good),
        'http://api/b': response(good),
        'http://api/c': response(good),
      },
      2,
    );
    await cache.get('/a');
    await cache.get('/b');
    await cache.get('/a'); // touch a: b is now the oldest
    await cache.get('/c'); // evicts b
    expect(cache.keys()).toEqual(['/a', '/c']);
    await cache.get('/b');
    expect(cache.keys()).toEqual(['/c', '/b']);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
