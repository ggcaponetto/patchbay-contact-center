// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  type DeskState,
  formatDuration,
  formatSince,
  initialState,
  myPresence,
  parseRoute,
  reduce,
  secondsLeft,
} from './store.ts';

const agent = (
  userId: string,
  state: 'ready' | 'busy' = 'ready',
  callId: string | null = null,
) => ({
  userId,
  name: userId.toUpperCase(),
  state,
  reason: null,
  since: '2026-01-01T00:00:00Z',
  callId,
  acwUntil: null,
});

const run = (actions: Parameters<typeof reduce>[1][], start: DeskState = initialState) =>
  actions.reduce(reduce, start);

describe('desk store', () => {
  it('tracks the socket, presence (own state included) and a forced logout', () => {
    let s = run([{ type: 'socket', connected: true }]);
    expect(s).toMatchObject({ connected: true, loggedOutBy: null });
    expect(myPresence(s, 'u')).toBeUndefined();
    s = run(
      [{ type: 'server', message: { type: 'presence', agents: [agent('u', 'busy', 'c')] } }],
      s,
    );
    expect(s.agents).toHaveLength(1);
    expect(myPresence(s, 'u')).toMatchObject({ state: 'busy', callId: 'c' });
    s = run([{ type: 'socket', connected: false }], s);
    expect(s.agents).toEqual([]);
    s = run([{ type: 'server', message: { type: 'logout', by: 'Boss' } }], s);
    expect(s).toMatchObject({ loggedOutBy: 'Boss', agents: [], offer: null });
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

  it('collects instant messages (capped at 20) and tracks the ticker', () => {
    const im = (text: string) => ({
      type: 'server' as const,
      message: {
        type: 'im' as const,
        from: { userId: 'u1', name: 'Boss' },
        text,
        broadcast: false,
      },
    });
    const s = run([...Array.from({ length: 25 }, (_v, i) => im(`m${i}`))]);
    expect(s.messages).toHaveLength(20);
    expect(s.messages.at(-1)?.text).toBe('m24');
    const t = run([{ type: 'server', message: { type: 'ticker', text: 'Maintenance tonight' } }]);
    expect(t.ticker).toBe('Maintenance tonight');
    expect(run([{ type: 'server', message: { type: 'ticker', text: '' } }]).ticker).toBe('');
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
    expect(formatSince('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:02:03Z'))).toBe('2:03');
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
