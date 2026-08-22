import { describe, expect, it } from 'vitest';
import { dbAvailable } from './testing.ts';

describe('dbAvailable', () => {
  it('is false for an unreachable database', async () => {
    expect(await dbAvailable('postgres://nobody:nothing@127.0.0.1:1/none')).toBe(false);
  });
});
