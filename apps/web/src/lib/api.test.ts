// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, del, patch, post, put, setTenant } from './api.ts';

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setTenant('');
  });

  it('prefixes /api, sends the tenant header, parses the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    setTenant('t1');
    await expect(api<{ ok: boolean }>('/me')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/me', {
      headers: { 'x-tenant-id': 't1' },
      credentials: 'include',
    });
  });

  it('omits the tenant header when none is selected and merges custom headers', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    await api('/x', { headers: { 'x-extra': '1' } });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ 'x-extra': '1' });
    // a body (post/patch/put) declares JSON; DELETE must not, or Fastify answers 400
    await post('/y', { a: 1 });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'content-type': 'application/json',
    });
    await del('/z');
    expect(fetchMock.mock.calls[2]?.[1]?.headers).not.toHaveProperty('content-type');
  });

  it('throws the error code of a non-ok body, or the status text', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ error: 'not_found' }, { status: 404 }))
        .mockResolvedValueOnce(new Response('nope', { status: 500, statusText: 'Server Error' })),
    );
    await expect(api('/a')).rejects.toMatchObject({ message: 'not_found', status: 404 });
    await expect(api('/a')).rejects.toMatchObject({ message: 'Server Error', status: 500 });
  });

  it('provides verb helpers', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({})));
    vi.stubGlobal('fetch', fetchMock);
    await post('/p');
    await post('/p', { a: 1 });
    await patch('/q', { b: 2 });
    await put('/r', { c: 3 });
    await del('/s');
    const calls = fetchMock.mock.calls.map(([path, init]) => [path, init.method, init.body]);
    expect(calls).toEqual([
      ['/api/p', 'POST', '{}'],
      ['/api/p', 'POST', '{"a":1}'],
      ['/api/q', 'PATCH', '{"b":2}'],
      ['/api/r', 'PUT', '{"c":3}'],
      ['/api/s', 'DELETE', undefined],
    ]);
  });
});
