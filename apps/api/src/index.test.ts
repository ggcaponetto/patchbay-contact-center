import { describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({ start: vi.fn(async () => undefined) }));
vi.mock('./boot.ts', () => ({ start: fakes.start }));

describe('entrypoint', () => {
  it('boots the API once on import', async () => {
    await import('./index.ts');
    expect(fakes.start).toHaveBeenCalledTimes(1);
  });
});
