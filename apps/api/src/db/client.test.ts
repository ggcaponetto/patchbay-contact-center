import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from './client.ts';

describe('createDb', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('refuses to start without a connection string', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => createDb()).toThrow('DATABASE_URL is not set');
    vi.stubEnv('DATABASE_URL', undefined);
    expect(() => createDb()).toThrow('DATABASE_URL is not set');
    expect(() => createDb('')).toThrow('DATABASE_URL is not set');
  });

  it('builds a lazy pool from DATABASE_URL or the argument', async () => {
    // pg.Pool connects on first query only, so nothing talks to a database here.
    vi.stubEnv('DATABASE_URL', 'postgres://u:p@127.0.0.1:1/env');
    const fromEnv = createDb();
    expect(fromEnv.db.query).toHaveProperty('user');
    await fromEnv.close();
    const explicit = createDb('postgres://u:p@127.0.0.1:1/arg');
    expect(explicit.db.query).toHaveProperty('call');
    await explicit.close();
  });
});
