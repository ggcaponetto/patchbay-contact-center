// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, del, fetchAsDevUser, patch, post, put, setTenant } from './api.ts';

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
    sessionStorage.clear();
  });

  it("sends the tab's dev user as x-dev-user, and nothing when there is none", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    await api('/me');
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-dev-user');
    sessionStorage.setItem('cc_dev_user', 'alice@patchbay.dev');
    await api('/me');
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({ 'x-dev-user': 'alice@patchbay.dev' });
    // an explicit header wins (the menu asks for the default user with an empty one)
    await api('/me', { headers: { 'x-dev-user': '' } });
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({ 'x-dev-user': '' });
  });

  it('gives the Better Auth client a fetch that reads the dev user per request', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({}));
    vi.stubGlobal('fetch', fetchMock);
    await fetchAsDevUser('/api/auth/get-session', { headers: { accept: 'application/json' } });
    let headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('x-dev-user')).toBeNull();
    sessionStorage.setItem('cc_dev_user', 'bob@patchbay.dev');
    await fetchAsDevUser('/api/auth/get-session');
    headers = fetchMock.mock.calls[1]?.[1]?.headers as Headers;
    expect(headers.get('x-dev-user')).toBe('bob@patchbay.dev');
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
