// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  type DeskState,
  formatDuration,
  initialState,
  parseRoute,
  reduce,
  secondsLeft,
} from './store.ts';

const run = (actions: Parameters<typeof reduce>[1][], start: DeskState = initialState) =>
  actions.reduce(reduce, start);

describe('desk store', () => {
  it('tracks socket and own status', () => {
    let s = run([
      { type: 'socket', connected: true },
      { type: 'myStatus', status: 'available' },
    ]);
    expect(s).toMatchObject({ connected: true, myStatus: 'available' });
    s = run(
      [
        {
          type: 'server',
          message: {
            type: 'presence',
            agents: [{ userId: 'u', name: 'U', status: 'busy', callId: 'c' }],
          },
        },
      ],
      s,
    );
    expect(s.agents).toHaveLength(1);
    s = run([{ type: 'socket', connected: false }], s);
    expect(s.agents).toEqual([]);
  });

  it('handles offers, cancellations and call updates', () => {
    const offer = {
      type: 'call.offer' as const,
      callId: 'c1',
      queueKey: 'support',
      reason: 'refund',
      expiresAt: '2026-01-01T00:00:20.000Z',
    };
    let s = run([{ type: 'server', message: offer }]);
    expect(s.offer).toEqual({
      callId: 'c1',
      queueKey: 'support',
      reason: 'refund',
      expiresAt: offer.expiresAt,
    });
    expect(
      run([{ type: 'server', message: { type: 'call.offer.cancelled', callId: 'other' } }], s)
        .offer,
    ).not.toBeNull();
    expect(
      run([{ type: 'server', message: { type: 'call.offer.cancelled', callId: 'c1' } }], s).offer,
    ).toBeNull();
    expect(run([{ type: 'offer.clear' }], s).offer).toBeNull();
    s = run(
      [{ type: 'server', message: { type: 'call.updated', callId: 'c1', status: 'human' } }],
      s,
    );
    expect(s).toMatchObject({ callStatus: { c1: 'human' }, callsVersion: 1 });
    expect(s.offer).not.toBeNull();
    s = run(
      [{ type: 'server', message: { type: 'call.updated', callId: 'c1', status: 'ended' } }],
      s,
    );
    expect(s.offer).toBeNull();
    expect(s.callsVersion).toBe(2);
  });

  it('appends transcript segments per call', () => {
    const seg = { speaker: 'ai' as const, identity: 'ai:1', text: 'hi' };
    const s = run([
      { type: 'server', message: { type: 'transcript', callId: 'c1', segment: seg } },
      {
        type: 'server',
        message: { type: 'transcript', callId: 'c1', segment: { ...seg, text: 'again' } },
      },
      { type: 'server', message: { type: 'transcript', callId: 'c2', segment: seg } },
    ]);
    expect(s.transcripts.c1?.map((t) => t.text)).toEqual(['hi', 'again']);
    expect(s.transcripts.c2).toHaveLength(1);
  });

  it('computes offer countdowns and durations', () => {
    const offer = { callId: 'c', queueKey: 'q', expiresAt: '2026-01-01T00:00:20.000Z' };
    expect(secondsLeft(offer, Date.parse('2026-01-01T00:00:05.500Z'))).toBe(15);
    expect(secondsLeft(offer, Date.parse('2026-01-01T00:01:00.000Z'))).toBe(0);
    expect(formatDuration('2026-01-01T00:00:00Z', '2026-01-01T00:01:05Z', 0)).toBe('1:05');
    expect(formatDuration('2026-01-01T00:00:00Z', null, Date.parse('2026-01-01T00:00:09Z'))).toBe(
      '0:09',
    );
    expect(formatDuration('2026-01-01T00:00:10Z', null, 0)).toBe('0:00');
  });

  it('parses hash routes', () => {
    expect(parseRoute('')).toEqual({ page: 'desk' });
    expect(parseRoute('#/desk')).toEqual({ page: 'desk' });
    expect(parseRoute('#/dashboard')).toEqual({ page: 'dashboard' });
    expect(parseRoute('#/history')).toEqual({ page: 'history' });
    expect(parseRoute('#/settings')).toEqual({ page: 'settings' });
    expect(parseRoute('#/calls/abc')).toEqual({ page: 'call', id: 'abc' });
    expect(parseRoute('#/calls/')).toEqual({ page: 'history' });
    expect(parseRoute('#/nope')).toEqual({ page: 'desk' });
  });
});
