import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAMPLE_RATE, renderLoop } from './music.ts';
import { createWorker } from './worker.ts';

describe('renderLoop', () => {
  it('renders a deterministic, clipped, non-silent loop', () => {
    const loop = renderLoop();
    expect(loop.length).toBe(SAMPLE_RATE * 0.8 * 10);
    expect(loop).toEqual(renderLoop());
    const max = loop.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(max).toBeGreaterThan(1000);
    expect(max).toBeLessThan(32767 * 0.25);
    // envelope: the very first sample of a note is silent (no click)
    expect(loop[0]).toBe(0);
    // the bright style is a different, shorter loop (0.5 s per note vs 0.8 s)
    const bright = renderLoop('bright');
    expect(bright.length).toBe(SAMPLE_RATE * 0.5 * 10);
    expect(bright).not.toEqual(loop.subarray(0, bright.length));
  });
});

describe('createWorker', () => {
  const rooms: {
    publish: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    closed: () => void;
  }[] = [];
  const connect = vi.fn(async () => {
    const room = {
      publish: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      closed: () => undefined as void,
      onClosed(handler: () => void) {
        this.closed = handler;
      },
    };
    rooms.push(room);
    return room;
  });
  const log = vi.fn();
  const fileLoop = new Int16Array(960).fill(1234);
  const resolveLoop = vi.fn(async (music: string | undefined, style: 'calm' | 'bright') =>
    music ? fileLoop : renderLoop(style),
  );
  const deps = { connect, log, resolveLoop };
  const startCmd = (callId = 'c1', extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      kind: 'media',
      command: { action: 'moh.start', callId, roomName: 'r', token: 't', url: 'wss://x', ...extra },
    });

  beforeEach(() => {
    rooms.length = 0;
    connect.mockClear();
    log.mockClear();
    resolveLoop.mockClear();
  });

  it('starts one session per call, ignores duplicates and stops on command', async () => {
    const worker = createWorker(deps);
    await worker.handle('not json');
    await worker.handle(JSON.stringify({ kind: 'send' }));
    await worker.handle(JSON.stringify({ kind: 'media', command: { action: 'nope' } }));
    expect(log).toHaveBeenCalledWith('dropped malformed media command');
    expect(connect).not.toHaveBeenCalled();

    await worker.handle(startCmd());
    await worker.handle(startCmd()); // duplicate: same call keeps one session
    expect(connect).toHaveBeenCalledTimes(1);
    expect(rooms[0]!.publish).toHaveBeenCalledWith(expect.any(Int16Array), SAMPLE_RATE, 480);
    expect(resolveLoop).toHaveBeenCalledWith(undefined, 'calm');
    expect(log).toHaveBeenCalledWith('moh started for c1 in r (calm)');
    expect(worker.size()).toBe(1);

    await worker.handle(
      JSON.stringify({ kind: 'media', command: { action: 'moh.stop', callId: 'c1' } }),
    );
    expect(rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
    expect(worker.size()).toBe(0);
    // stopping again is a no-op
    await worker.handle(
      JSON.stringify({ kind: 'media', command: { action: 'moh.stop', callId: 'c1' } }),
    );
  });

  it('plays the configured file, resolved before joining, and names it in the log', async () => {
    const worker = createWorker(deps);
    await worker.handle(startCmd('c1', { style: 'bright', music: '/api/public/media/m1' }));
    expect(resolveLoop).toHaveBeenCalledWith('/api/public/media/m1', 'bright');
    expect(resolveLoop.mock.invocationCallOrder[0]).toBeLessThan(
      connect.mock.invocationCallOrder[0]!,
    );
    expect(rooms[0]!.publish).toHaveBeenCalledWith(fileLoop, SAMPLE_RATE, 480);
    expect(log).toHaveBeenCalledWith('moh started for c1 in r (/api/public/media/m1)');
    expect(worker.size()).toBe(1);
    await worker.close();
  });

  it('honours a stop that arrives while the loop is still resolving', async () => {
    let release: () => void = () => undefined;
    resolveLoop.mockImplementationOnce(() => new Promise((r) => (release = () => r(fileLoop))));
    const worker = createWorker(deps);
    const starting = worker.handle(startCmd('c1', { music: 'https://x/slow.wav' }));
    await worker.handle(
      JSON.stringify({ kind: 'media', command: { action: 'moh.stop', callId: 'c1' } }),
    );
    release();
    await starting;
    expect(connect).not.toHaveBeenCalled();
    expect(worker.size()).toBe(0);
  });

  it('honours a stop that arrives while the room is still connecting', async () => {
    let release: () => void = () => undefined;
    const slowRoom = {
      publish: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      onClosed: () => undefined,
    };
    connect.mockImplementationOnce(
      () => new Promise((r) => (release = () => r(slowRoom as never))),
    );
    const worker = createWorker(deps);
    const starting = worker.handle(startCmd('c1'));
    while (connect.mock.calls.length === 0) await Promise.resolve(); // loop resolved, join in flight
    await worker.handle(
      JSON.stringify({ kind: 'media', command: { action: 'moh.stop', callId: 'c1' } }),
    );
    release();
    await starting;
    expect(slowRoom.disconnect).toHaveBeenCalledTimes(1);
    expect(slowRoom.publish).not.toHaveBeenCalled();
    expect(worker.size()).toBe(0);
  });

  it('cleans up when the room closes under it, logs failures, closes all on shutdown', async () => {
    const worker = createWorker(deps);
    await worker.handle(startCmd('c1'));
    rooms[0]!.closed();
    await Promise.resolve();
    expect(worker.size()).toBe(0);

    connect.mockRejectedValueOnce(new Error('boom'));
    await worker.handle(startCmd('c2'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('moh failed for c2'));
    expect(worker.size()).toBe(0);

    await worker.handle(startCmd('c3'));
    await worker.handle(startCmd('c4'));
    expect(worker.size()).toBe(2);
    await worker.close();
    expect(worker.size()).toBe(0);
  });
});
