import { describe, expect, it, vi } from 'vitest';
import { type BootDeps, start } from './boot.ts';

/** Fakes for every factory `start` composes, recording what it was given. */
function fakeDeps() {
  const db = { tag: 'db' };
  const livekit = { tag: 'livekit' };
  const auth = { tag: 'auth' };
  const app = { listen: vi.fn(async () => undefined), log: { fatal: vi.fn() } };
  const bus = { tag: 'bus', start: vi.fn(async () => undefined) };
  const routing = { start: vi.fn() };
  const spies = {
    runMigrations: vi.fn(async () => undefined),
    createDb: vi.fn(() => ({ db, close: async () => undefined })),
    createLiveKit: vi.fn(() => livekit),
    createAuth: vi.fn(() => auth),
    buildServer: vi.fn(async () => ({ app, flow: { routing } })),
    createBus: vi.fn(() => bus),
  };
  return { deps: spies as unknown as BootDeps, spies, db, livekit, auth, app, bus, routing };
}

describe('start', () => {
  it('migrates, wires Better Auth and listens on PORT', async () => {
    const f = fakeDeps();
    const app = await start({ PORT: '4321', NODE_ENV: 'production', DEV_USER_EMAIL: 'x' }, f.deps);
    expect(app).toBe(f.app);
    expect(f.spies.runMigrations).toHaveBeenCalledTimes(1);
    expect(f.spies.runMigrations.mock.invocationCallOrder[0]).toBeLessThan(
      f.spies.createDb.mock.invocationCallOrder[0]!,
    );
    expect(f.spies.createAuth).toHaveBeenCalledWith(f.db);
    expect(f.spies.buildServer).toHaveBeenCalledWith({
      db: f.db,
      livekit: f.livekit,
      auth: f.auth,
      bus: f.bus,
    });
    expect(f.bus.start).toHaveBeenCalledTimes(1);
    expect(f.routing.start).toHaveBeenCalledTimes(1);
    expect(f.app.listen).toHaveBeenCalledWith({ port: 4321, host: '0.0.0.0' });
  });

  it('uses the dev bypass outside production and port 4000 by default', async () => {
    const f = fakeDeps();
    await start({ NODE_ENV: 'development', DEV_USER_EMAIL: 'dev@example.com' }, f.deps);
    expect(f.spies.createAuth).not.toHaveBeenCalled();
    expect(f.spies.buildServer).toHaveBeenCalledWith({
      db: f.db,
      livekit: f.livekit,
      bus: f.bus,
      devUserEmail: 'dev@example.com',
      devDemoTeam: true,
    });
    await start(
      { NODE_ENV: 'development', DEV_USER_EMAIL: 'dev@example.com', DEV_DEMO_TEAM: 'false' },
      f.deps,
    );
    expect(f.spies.buildServer).toHaveBeenLastCalledWith(
      expect.objectContaining({ devDemoTeam: false }),
    );
    expect(f.app.listen).toHaveBeenCalledWith({ port: 4000, host: '0.0.0.0' });
  });

  it('falls back to Better Auth when DEV_USER_EMAIL is unset', async () => {
    const f = fakeDeps();
    await start({}, f.deps);
    expect(f.spies.createAuth).toHaveBeenCalledTimes(1);
  });

  it('explains a taken port and rethrows; other listen errors are rethrown silently', async () => {
    const f = fakeDeps();
    const busy = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    f.app.listen.mockRejectedValueOnce(busy);
    await expect(start({ PORT: '4000' }, f.deps)).rejects.toBe(busy);
    expect(f.app.log.fatal).toHaveBeenCalledWith(expect.stringContaining('Port 4000'));

    const other = new Error('boom');
    f.app.listen.mockRejectedValueOnce(other);
    await expect(start({}, f.deps)).rejects.toBe(other);
    expect(f.app.log.fatal).toHaveBeenCalledTimes(1);
  });
});
