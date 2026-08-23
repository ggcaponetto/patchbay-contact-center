// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { type CallState, formatDuration, peerInfo, reduce, statusKey } from './state.ts';

const run = (events: Parameters<typeof reduce>[1][], start: CallState = { kind: 'idle' }) =>
  events.reduce(reduce, start);

describe('call state machine', () => {
  it('walks through a normal AI call', () => {
    let s = run([{ type: 'click' }]);
    expect(s).toEqual({ kind: 'connecting' });
    s = run([{ type: 'connected', at: 1000 }], s);
    expect(s).toEqual({ kind: 'waiting', since: 1000 });
    s = run([{ type: 'peer_joined', role: 'ai', name: undefined }], s);
    expect(s).toMatchObject({ kind: 'in_call', with: { kind: 'ai' }, muted: false });
    s = run([{ type: 'toggle_mute' }], s);
    expect(s).toMatchObject({ muted: true });
    s = run([{ type: 'peer_joined', role: 'human', name: 'Sam' }], s);
    expect(s).toMatchObject({ with: { kind: 'human', name: 'Sam' }, muted: true });
    s = run([{ type: 'peer_joined', role: 'ai', name: undefined }], s);
    expect(s).toMatchObject({ with: { kind: 'human', name: 'Sam' } });
    s = run([{ type: 'peer_left', role: 'ai' }], s);
    expect(s.kind).toBe('in_call');
    s = run([{ type: 'hangup' }], s);
    expect(s).toEqual({ kind: 'ended' });
    expect(run([{ type: 'click' }], s)).toEqual({ kind: 'connecting' });
  });

  it('ignores events that do not apply', () => {
    expect(run([{ type: 'connected', at: 1 }])).toEqual({ kind: 'idle' });
    expect(run([{ type: 'toggle_mute' }])).toEqual({ kind: 'idle' });
    expect(run([{ type: 'hangup' }])).toEqual({ kind: 'idle' });
    expect(run([{ type: 'peer_joined', role: 'ai', name: undefined }])).toEqual({ kind: 'idle' });
    const waiting: CallState = { kind: 'waiting', since: 0 };
    expect(run([{ type: 'peer_joined', role: 'transcriber', name: undefined }], waiting)).toBe(
      waiting,
    );
    expect(run([{ type: 'click' }], waiting)).toBe(waiting);
    expect(run([{ type: 'disconnected' }], waiting)).toEqual({ kind: 'ended' });
  });

  it('handles errors and resets', () => {
    const err = run([{ type: 'click' }, { type: 'error', message: 'mic denied' }]);
    expect(err).toEqual({ kind: 'error', message: 'mic denied' });
    expect(run([{ type: 'disconnected' }], err)).toBe(err);
    expect(run([{ type: 'click' }], err)).toEqual({ kind: 'connecting' });
    expect(run([{ type: 'reset' }], err)).toEqual({ kind: 'idle' });
  });

  it('maps states to status keys and formats durations', () => {
    expect(statusKey({ kind: 'idle' }, 0)).toEqual({ key: null });
    expect(statusKey({ kind: 'connecting' }, 0)).toEqual({ key: 'connecting' });
    expect(statusKey({ kind: 'waiting', since: 0 }, 0)).toEqual({ key: 'pleaseHold' });
    expect(
      statusKey({ kind: 'in_call', since: 0, with: { kind: 'ai' }, muted: false }, 65_000),
    ).toEqual({ key: 'inCall', peer: { kind: 'ai' }, duration: '1:05' });
    expect(statusKey({ kind: 'ended' }, 0)).toEqual({ key: 'ended' });
    expect(statusKey({ kind: 'error', message: 'x' }, 0)).toEqual({
      key: 'couldNotStart',
      message: 'x',
    });
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(600_000)).toBe('10:00');
    expect(peerInfo('human', undefined)).toEqual({ kind: 'human', name: '' });
    expect(peerInfo('ai', 'ignored')).toEqual({ kind: 'ai' });
  });
});
