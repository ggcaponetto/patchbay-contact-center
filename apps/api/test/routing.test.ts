import type { ServerMessage } from '@cc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Routing } from '../src/routing.ts';

describe('Routing', () => {
  const sent: { to: string; msg: ServerMessage }[] = [];
  const nobody = vi.fn();
  const accepted = vi.fn();
  const presence = vi.fn();
  let r: Routing;

  const agent = (
    userId: string,
    queues = ['support'],
    status: 'available' | 'away' = 'available',
  ) => r.setPresence({ userId, tenantId: 't1', name: userId, status, queues });
  const offersTo = () => sent.filter((s) => s.msg.type === 'call.offer').map((s) => s.to);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    sent.length = 0;
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
    agent('d', ['support'], 'away');
    r.offer({ callId: 'c1', tenantId: 't1', queueKey: 'support', reason: 'billing', summary: 'x' });
    expect(offersTo()).toEqual(['a']);
    expect(sent[0]!.msg).toMatchObject({ type: 'call.offer', reason: 'billing', summary: 'x' });
    expect(r.ringing('c1')).toBe('a');
    // duplicate offers are ignored
    r.offer({ callId: 'c1', tenantId: 't1', queueKey: 'support' });
    expect(offersTo()).toEqual(['a']);

    r.decline('c1', 'b'); // not b's offer
    expect(offersTo()).toEqual(['a']);
    r.decline('c1', 'a');
    expect(offersTo()).toEqual(['a', 'b']);
    expect(sent.some((s) => s.to === 'a' && s.msg.type === 'call.offer.cancelled')).toBe(true);

    expect(r.accept('c1', 'a')).toBe(false);
    expect(r.accept('c1', 'b')).toBe(true);
    expect(accepted).toHaveBeenCalledWith('c1', 'b');
    expect(r.snapshot('t1').find((p) => p.userId === 'b')).toMatchObject({
      status: 'busy',
      callId: 'c1',
    });
    expect(r.ringing('c1')).toBeNull();

    r.release('c1');
    expect(r.snapshot('t1').find((p) => p.userId === 'b')).toMatchObject({
      status: 'available',
      callId: null,
    });
    expect(nobody).not.toHaveBeenCalled();
  });

  it('moves on after the ring timeout and gives up when everyone was tried', () => {
    agent('a');
    agent('b');
    r.offer({ callId: 'c1', tenantId: 't1', queueKey: 'support' });
    vi.advanceTimersByTime(10_000);
    expect(offersTo()).toEqual(['a', 'b']);
    vi.advanceTimersByTime(10_000);
    expect(nobody).toHaveBeenCalledWith('c1', 't1');
    expect(r.ringing('c1')).toBeNull();
  });

  it('gives up immediately when nobody is online for the queue', () => {
    agent('x', ['sales']);
    r.offer({ callId: 'c1', tenantId: 't1', queueKey: 'support' });
    expect(nobody).toHaveBeenCalledTimes(1);
  });

  it('respects the overall deadline in human-first mode', () => {
    agent('a');
    agent('b');
    agent('c');
    r.offer({ callId: 'c1', tenantId: 't1', queueKey: 'support', giveUpAfterSec: 15 });
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
    r.offer({ callId: 'c1', tenantId: 't1', queueKey: 'support' });
    r.offer({ callId: 'c2', tenantId: 't1', queueKey: 'support' });
    expect(offersTo()).toEqual(['a', 'b']);
    r.removePresence('a'); // a's desk closed while ringing -> c1 moves on, but b is busy ringing c2
    expect(nobody).toHaveBeenCalledWith('c1', 't1');
    r.removePresence('nobody-here');
    r.accept('c2', 'b');
    r.offer({ callId: 'c3', tenantId: 't1', queueKey: 'support' });
    expect(nobody).toHaveBeenCalledWith('c3', 't1');
    // releasing an unknown call and cancelling a ringing offer
    r.release('c-unknown');
    agent('z');
    r.offer({ callId: 'c4', tenantId: 't1', queueKey: 'support' });
    r.release('c4');
    expect(sent.at(-1)).toMatchObject({
      to: 'z',
      msg: { type: 'call.offer.cancelled', callId: 'c4' },
    });
    expect(r.snapshot('t2')).toEqual([]);
  });
});
