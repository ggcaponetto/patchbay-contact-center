import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  migrate: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  createDb: vi.fn(),
}));
vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: fakes.migrate }));
vi.mock('./client.ts', () => ({ createDb: fakes.createDb }));

describe('runMigrations', () => {
  const argv1 = process.argv[1];
  beforeEach(() => {
    vi.resetModules();
    fakes.createDb.mockReturnValue({ db: { tag: 'db' }, close: fakes.close });
  });
  afterEach(() => {
    process.argv[1] = argv1;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('migrates from apps/api/drizzle and closes the pool, even on failure', async () => {
    const { runMigrations } = await import('./migrate.ts');
    await runMigrations('postgres://x');
    expect(fakes.createDb).toHaveBeenCalledWith('postgres://x');
    expect(fakes.migrate).toHaveBeenCalledWith(
      { tag: 'db' },
      { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) },
    );
    expect(fakes.close).toHaveBeenCalledTimes(1);

    fakes.migrate.mockRejectedValueOnce(new Error('boom'));
    await expect(runMigrations()).rejects.toThrow('boom');
    expect(fakes.createDb).toHaveBeenLastCalledWith(undefined);
    expect(fakes.close).toHaveBeenCalledTimes(2);
  });

  it('runs once and reports when executed as a script', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.argv[1] = fileURLToPath(new URL('./migrate.ts', import.meta.url));
    await import('./migrate.ts');
    expect(fakes.migrate).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('migrations applied');
  });
});
