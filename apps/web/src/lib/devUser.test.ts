// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootDevUser, devHeaders, devUser, openAs, setDevUser } from './devUser.ts';

describe('devUser', () => {
  beforeEach(() => {
    sessionStorage.clear();
    history.replaceState(null, '', '/');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is the default user until one is set, then sends the header', () => {
    expect(devUser()).toBeNull();
    expect(devHeaders()).toEqual({});
    setDevUser(' Alice@Patchbay.dev ');
    expect(devUser()).toBe('alice@patchbay.dev');
    expect(devHeaders()).toEqual({ 'x-dev-user': 'alice@patchbay.dev' });
    expect(sessionStorage.getItem('cc_dev_user')).toBe('alice@patchbay.dev');
    setDevUser(null);
    expect(devUser()).toBeNull();
    expect(sessionStorage.getItem('cc_dev_user')).toBeNull();
  });

  it('boots from ?as= in the search and strips it', () => {
    history.replaceState(null, '', '/?as=bob%40patchbay.dev&x=1#/desk');
    expect(bootDevUser()).toBe('bob@patchbay.dev');
    expect(location.search).toBe('?x=1');
    expect(location.hash).toBe('#/desk');
    expect(devUser()).toBe('bob@patchbay.dev');
  });

  it('boots from #/?as= in the hash and strips it, keeping other hash params', () => {
    history.replaceState(null, '', '/#/?as=carol%40patchbay.dev&tab=2');
    expect(bootDevUser()).toBe('carol@patchbay.dev');
    expect(location.hash).toBe('#/?tab=2');
    history.replaceState(null, '', '/#/dashboard?as=sam%40patchbay.dev');
    expect(bootDevUser()).toBe('sam@patchbay.dev');
    expect(location.hash).toBe('#/dashboard');
  });

  it('keeps the stored user when the URL names none', () => {
    sessionStorage.setItem('cc_dev_user', 'alice@patchbay.dev');
    history.replaceState(null, '', '/#/desk');
    expect(bootDevUser()).toBe('alice@patchbay.dev');
    expect(location.hash).toBe('#/desk');
  });

  it('opens a new tab with #/?as=', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    openAs('alice@patchbay.dev');
    expect(open).toHaveBeenCalledWith('/#/?as=alice%40patchbay.dev', '_blank');
  });

  it('survives a missing or throwing sessionStorage', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(devUser()).toBeNull();
    setDevUser('x@y.z');
    expect(devHeaders()).toEqual({});
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('denied');
        },
      },
    );
    vi.stubGlobal('sessionStorage', throwing);
    expect(devUser()).toBeNull();
    expect(() => setDevUser('x@y.z')).not.toThrow();
    expect(() => setDevUser(null)).not.toThrow();
    expect(bootDevUser()).toBeNull();
  });
});
