import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api.ts';

describe('ApiClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to the internal endpoints with the shared secret', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const log = vi.fn();
    const api = new ApiClient('http://api', 'secret', 'call-1', log);
    await api.transcript({ speaker: 'ai', identity: 'ai:call-1', text: 'hi' });
    await api.event('ai.joined');
    await api.participant('ai', 'ai:call-1');
    await api.status('ended', 'done');
    await api.status('ai');
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map((c) => c[0])).toEqual([
      'http://api/api/internal/calls/call-1/transcript',
      'http://api/api/internal/calls/call-1/events',
      'http://api/api/internal/calls/call-1/participants',
      'http://api/api/internal/calls/call-1/status',
      'http://api/api/internal/calls/call-1/status',
    ]);
    expect((calls[0]![1].headers as Record<string, string>)['x-internal-secret']).toBe('secret');
    expect(JSON.parse(calls[3]![1].body as string)).toEqual({ status: 'ended', summary: 'done' });
    expect(JSON.parse(calls[4]![1].body as string)).toEqual({ status: 'ai' });
    expect(log).not.toHaveBeenCalled();
  });

  it('logs instead of throwing on failures', async () => {
    const log = vi.fn();
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    await new ApiClient('http://api', 's', 'c', log).event('x');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('500'));
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    await new ApiClient('http://api', 's', 'c', log).event('x');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });
});
