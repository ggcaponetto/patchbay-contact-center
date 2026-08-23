// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSynthRing, startUrlRing, useRingtone, zipTone } from './sounds.ts';

/** A minimal WebAudio fake recording what the sounds do with it. */
function fakeAudioContext() {
  const ctx = {
    currentTime: 0,
    closed: 0,
    oscillators: [] as { frequency: { value: number }; started: boolean; stopAt?: number }[],
    gains: [] as { schedule: [number, number][]; gain: { value: number } }[],
    destination: {},
    createOscillator() {
      const osc = {
        frequency: { value: 0 },
        started: false,
        stopAt: undefined as number | undefined,
        onended: null as null | (() => void),
        connect: (to: unknown) => to,
        start: () => {
          osc.started = true;
        },
        stop: (at: number) => {
          osc.stopAt = at;
          queueMicrotask(() => osc.onended?.());
        },
      };
      ctx.oscillators.push(osc);
      return osc;
    },
    createGain() {
      const g = {
        schedule: [] as [number, number][],
        gain: {
          value: 0,
          setValueAtTime: (v: number, t: number) => g.schedule.push([v, t]),
        },
        connect: (to: unknown) => to,
      };
      ctx.gains.push(g);
      return g;
    },
    close: async () => {
      ctx.closed++;
    },
  };
  return ctx;
}

describe('sounds', () => {
  let ctx: ReturnType<typeof fakeAudioContext>;
  beforeEach(() => {
    ctx = fakeAudioContext();
    vi.stubGlobal('AudioContext', function () {
      return ctx;
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('zipTone beeps once at 880 Hz and closes the context', async () => {
    zipTone();
    expect(ctx.oscillators[0]).toMatchObject({ frequency: { value: 880 }, started: true });
    expect(ctx.oscillators[0]!.stopAt).toBeCloseTo(0.25);
    await Promise.resolve();
    expect(ctx.closed).toBe(1);
  });

  it('the built-in ring is a 440 + 480 Hz double tone with a cadence, until stopped', () => {
    const stop = startSynthRing();
    expect(ctx.oscillators.map((o) => o.frequency.value)).toEqual([440, 480]);
    const gain = ctx.gains[0]!;
    expect(gain.schedule.slice(0, 4)).toEqual([
      [0.15, 0],
      [0, 1.2],
      [0.15, 4],
      [0, 5.2],
    ]);
    const before = gain.schedule.length;
    ctx.currentTime = 8;
    vi.advanceTimersByTime(4000);
    expect(gain.schedule.length).toBeGreaterThan(before);
    stop();
    expect(ctx.closed).toBe(1);
    const after = gain.schedule.length;
    vi.advanceTimersByTime(8000);
    expect(gain.schedule.length).toBe(after);
  });

  it('does nothing without WebAudio', () => {
    vi.stubGlobal('AudioContext', undefined);
    expect(() => zipTone()).not.toThrow();
    expect(startSynthRing()).toBeTypeOf('function');
  });

  it('plays a looping audio element for a URL and stops it', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValue(new Error('x'));
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const stop = startUrlRing('https://x/ring.mp3');
    expect(play).toHaveBeenCalledTimes(1);
    await Promise.resolve(); // the rejected play() is swallowed
    stop();
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('useRingtone rings while active and switches between URL and synth', () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    const { rerender, unmount } = renderHook(
      ({ active, url }: { active: boolean; url?: string }) => useRingtone(active, url),
      { initialProps: { active: false } },
    );
    expect(ctx.oscillators).toHaveLength(0);
    rerender({ active: true });
    expect(ctx.oscillators).toHaveLength(2);
    rerender({ active: true, url: 'https://x/r.mp3' });
    expect(ctx.closed).toBe(1); // synth stopped, audio element took over
    rerender({ active: false, url: 'https://x/r.mp3' });
    expect(pause).toHaveBeenCalledTimes(1);
    rerender({ active: true, url: 'https://x/r.mp3' });
    unmount();
    expect(pause).toHaveBeenCalledTimes(2);
  });
});
