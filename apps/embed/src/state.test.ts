// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { type CallState, formatDuration, peerLabel, reduce, statusText } from './state.ts';

const run = (events: Parameters<typeof reduce>[1][], start: CallState = { kind: 'idle' }) =>
  events.reduce(reduce, start);

describe('call state machine', () => {
  it('walks through a normal AI call', () => {
    let s = run([{ type: 'click' }]);
    expect(s).toEqual({ kind: 'connecting' });
    s = run([{ type: 'connected', at: 1000 }], s);
    expect(s).toEqual({ kind: 'waiting', since: 1000 });
    s = run([{ type: 'peer_joined', role: 'ai', name: undefined }], s);
    expect(s).toMatchObject({ kind: 'in_call', with: 'AI assistant', muted: false });
    s = run([{ type: 'toggle_mute' }], s);
    expect(s).toMatchObject({ muted: true });
    s = run([{ type: 'peer_joined', role: 'human', name: 'Sam' }], s);
    expect(s).toMatchObject({ with: 'Agent Sam', muted: true });
    s = run([{ type: 'peer_joined', role: 'ai', name: undefined }], s);
    expect(s).toMatchObject({ with: 'Agent Sam' });
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

  it('formats status text and durations', () => {
    expect(statusText({ kind: 'idle' }, 0)).toBe('');
    expect(statusText({ kind: 'connecting' }, 0)).toContain('Connecting');
    expect(statusText({ kind: 'waiting', since: 0 }, 0)).toContain('hold');
    expect(
      statusText({ kind: 'in_call', since: 0, with: 'AI assistant', muted: false }, 65_000),
    ).toBe('AI assistant · 1:05');
    expect(statusText({ kind: 'ended' }, 0)).toContain('ended');
    expect(statusText({ kind: 'error', message: 'x' }, 0)).toContain('x');
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(600_000)).toBe('10:00');
    expect(peerLabel('human', undefined)).toBe('Agent');
  });
});
