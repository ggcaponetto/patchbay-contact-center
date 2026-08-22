import type { ServerMessage } from '@cc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Routing } from './routing.ts';

describe('Routing', () => {
  const sent: { to: string; msg: ServerMessage }[] = [];
  const nobody = vi.fn();
  const accepted = vi.fn();
  const presence = vi.fn();
  let r: Routing;

  /** Online agents; `support` is who the test offers may ring (queue membership). */
  const support: string[] = [];
  const agent = (userId: string, queues = ['support'], state: 'ready' | 'not_ready' = 'ready') => {
    if (queues.includes('support')) support.push(userId);
    r.connect({ userId, tenantId: 't1', name: userId });
    if (state === 'ready') r.setState(userId, 'ready');
  };
  const of = (userId: string) => r.snapshot('t1').find((p) => p.userId === userId);
  const offersTo = () => sent.filter((s) => s.msg.type === 'call.offer').map((s) => s.to);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    sent.length = 0;
    support.length = 0;
    nobody.mockClear();
    accepted.mockClear();
    presence.mockClear();
    r = new Routing(
      {
        send: (to, msg) => sent.push({ to, msg }),
        onNobody: nobody,
        onAccepted: accepted,
        presenceChanged: presence,
      },
      10,
    );
  });
  afterEach(() => vi.useRealTimers());

  it('rings available queue members one at a time and hands the call to the acceptor', () => {
    agent('a');
    agent('b');
    agent('c', ['sales']);
    agent('d', ['support'], 'not_ready');
    r.offer({
      callId: 'c1',
      tenantId: 't1',
      queueKey: 'support',
      members: support,
      reason: 'billing',
      summary: 'x',
    });
    expect(offersTo()).toEqual(['a']);
    expect(sent[0]!.msg).toMatchObject({ type: 'call.offer', reason: 'billing', summary: 'x' });
    expect(r.ringing('c1')).toBe('a');
    // duplicate offers are ignored
    r.offer({ callId: 'c1', tenantId: 't1', queueKey: 'support', members: support });
    expect(offersTo()).toEqual(['a']);

    r.decline('c1', 'b'); // not b's offer
    expect(offersTo()).toEqual(['a']);
    r.decline('c1', 'a');
    expect(offersTo()).toEqual(['a', 'b']);
    expect(sent.some((s) => s.to === 'a' && s.msg.type === 'call.offer.cancelled')).toBe(true);

    expect(r.accept('c1', 'a')).toBe(false);
    expect(r.accept('c1', 'b')).toBe(true);
    expect(accepted).toHaveBeenCalledWith('c1', 'b');
    expect(of('b')).toMatchObject({ state: 'busy', callId: 'c1', reason: null });
    expect(r.ringing('c1')).toBeNull();
    // no state change while on a call
    expect(r.setState('b', 'not_ready', 'Break')).toBe('on_call');

    r.release('c1');
    expect(of('b')).toMatchObject({ state: 'ready', callId: null, acwUntil: null });
    expect(nobody).not.toHaveBeenCalled();
  });

  it('moves on after the ring timeout and gives up when everyone was tried', () => {
    agent('a');
    agent('b');
    r.offer({ callId: 'c1', tenantId: 't1', queueKey: 'support', members: support });
    vi.advanceTimersByTime(10_000);
    expect(offersTo()).toEqual(['a', 'b']);
    // RONA: the agent who let it ring is parked
    expect(of('a')).toMatchObject({ state: 'not_ready', reason: 'RONA' });
    vi.advanceTimersByTime(10_000);
    expect(nobody).toHaveBeenCalledWith('c1', 't1');
    expect(r.ringing('c1')).toBeNull();
  });

  it('tracks states, reasons and time in state; wrap-up ends by itself or by hand', () => {
    expect(r.setState('ghost', 'ready')).toBe('offline');
    agent('a');
    expect(of('a')).toMatchObject({ state: 'ready', since: new Date(0).toISOString() });
    vi.setSystemTime(5_000);
    expect(r.setState('a', 'not_ready', 'Lunch')).toBeNull();
    expect(of('a')).toMatchObject({
      state: 'not_ready',
      reason: 'Lunch',
      since: new Date(5_000).toISOString(),
    });
    // a second tab does not reset the state
    r.connect({ userId: 'a', tenantId: 't1', name: 'a' });
    expect(of('a')).toMatchObject({ state: 'not_ready', reason: 'Lunch' });

    r.setState('a', 'ready');
    r.offer({ callId: 'c1', tenantId: 't1', queueKey: 'support', members: support });
    r.accept('c1', 'a');
    r.release('c1', { acwSec: 30 });
    expect(of('a')).toMatchObject({
      state: 'acw',
      callId: 'c1',
      acwUntil: new Date(35_000).toISOString(),
    });
    expect(r.extendAcw('a', 30)).toBe(true);
    expect(of('a')).toMatchObject({ acwUntil: new Date(65_000).toISOString() });
    vi.advanceTimersByTime(60_000);
    expect(of('a')).toMatchObject({ state: 'ready', callId: null, acwUntil: null });
    expect(r.extendAcw('a', 30)).toBe(false);

    // finishing wrap-up by hand
    r.busy('c2', 'a');
    expect(of('a')).toMatchObject({ state: 'busy', callId: 'c2' });
    r.release('c2', { acwSec: 30 });
    expect(r.setState('a', 'ready')).toBeNull();
    expect(of('a')).toMatchObject({ state: 'ready', acwUntil: null });
    vi.advanceTimersByTime(60_000); // the cancelled timer does nothing
    expect(of('a')).toMatchObject({ state: 'ready' });
    r.busy('c3', 'nobody-here');
    expect(r.presenceOf('a')?.userId).toBe('a');
  });

  it('gives up immediately when nobody is online for the queue', () => {
    agent('x', ['sales']);
    r.offer({ callId: 'c1', tenantId: 't1', queueKey: 'support', members: support });
    expect(nobody).toHaveBeenCalledTimes(1);
  });

  it('respects the overall deadline in human-first mode', () => {
    agent('a');
    agent('b');
    agent('c');
    r.offer({
      callId: 'c1',
      tenantId: 't1',
      queueKey: 'support',
      members: support,
      giveUpAfterSec: 15,
    });
    expect(sent[0]!.msg).toMatchObject({ expiresAt: new Date(10_000).toISOString() });
    vi.advanceTimersByTime(10_000);
    expect(offersTo()).toEqual(['a', 'b']);
    // second ring is shortened to the 5s left on the deadline
    expect((sent.at(-1)!.msg as { expiresAt: string }).expiresAt).toBe(
      new Date(15_000).toISOString(),
    );
    vi.advanceTimersByTime(5_000);
    expect(nobody).toHaveBeenCalledTimes(1);
    expect(offersTo()).toEqual(['a', 'b']);
  });

  it('skips agents who are already ringing or busy and handles disconnects', () => {
    agent('a');
    agent('b');
    r.offer({ callId: 'c1', tenantId: 't1', queueKey: 'support', members: support });
    r.offer({ callId: 'c2', tenantId: 't1', queueKey: 'support', members: support });
    expect(offersTo()).toEqual(['a', 'b']);
    r.removePresence('a'); // a's desk closed while ringing -> c1 moves on, but b is busy ringing c2
    expect(nobody).toHaveBeenCalledWith('c1', 't1');
    r.removePresence('nobody-here');
    r.accept('c2', 'b');
    r.offer({ callId: 'c3', tenantId: 't1', queueKey: 'support', members: support });
    expect(nobody).toHaveBeenCalledWith('c3', 't1');
    // releasing an unknown call and cancelling a ringing offer
    r.release('c-unknown');
    agent('z');
    r.offer({ callId: 'c4', tenantId: 't1', queueKey: 'support', members: support });
    r.release('c4');
    expect(sent.at(-1)).toMatchObject({
      to: 'z',
      msg: { type: 'call.offer.cancelled', callId: 'c4' },
    });
    expect(r.snapshot('t2')).toEqual([]);
  });
});
