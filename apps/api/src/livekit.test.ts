import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LiveKitClients, createLiveKit } from './livekit.ts';

/** Decodes the payload segment of a JWT without verifying it. */
const payload = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as {
    sub: string;
    name: string;
    attributes: Record<string, string>;
    video: Record<string, unknown>;
    roomConfig?: { agents: { agentName: string; metadata: string }[] };
    exp: number;
    nbf: number;
  };

describe('createLiveKit', () => {
  const calls: { deleted: string[]; dispatched: unknown[]; ctor: unknown[] } = {
    deleted: [],
    dispatched: [],
    ctor: [],
  };
  const fakeClients = (httpUrl: string, apiKey: string, apiSecret: string): LiveKitClients => {
    calls.ctor.push([httpUrl, apiKey, apiSecret]);
    return {
      rooms: {
        async deleteRoom(room) {
          calls.deleted.push(room);
          if (room === 'gone') throw new Error('not found');
        },
      },
      dispatch: {
        async createDispatch(room, agentName, opts) {
          calls.dispatched.push([room, agentName, opts]);
          return { room, agentName } as never;
        },
      },
    };
  };

  beforeEach(() => {
    vi.stubEnv('LIVEKIT_URL', 'wss://demo.livekit.cloud');
    vi.stubEnv('LIVEKIT_API_KEY', 'APIkey');
    vi.stubEnv('LIVEKIT_API_SECRET', 'api-secret-long-enough-for-hs256-signing');
    calls.deleted.length = 0;
    calls.dispatched.length = 0;
    calls.ctor.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses to start when any LIVEKIT_* variable is missing', () => {
    for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) {
      for (const value of ['', undefined]) {
        vi.stubEnv(name, value);
        expect(() => createLiveKit(fakeClients)).toThrow('LIVEKIT_URL/API_KEY/API_SECRET');
      }
      vi.stubEnv(name, 'x');
    }
  });

  it('talks to the HTTP form of the URL and hands clients the ws form', () => {
    const lk = createLiveKit(fakeClients);
    expect(lk.url).toBe('wss://demo.livekit.cloud');
    expect(calls.ctor).toEqual([
      ['https://demo.livekit.cloud', 'APIkey', 'api-secret-long-enough-for-hs256-signing'],
    ]);
  });

  it('constructs the SDK clients by default', () => {
    expect(createLiveKit().url).toBe('wss://demo.livekit.cloud');
  });

  it('mints 2-hour join tokens with identity, attributes and grants', async () => {
    const lk = createLiveKit(fakeClients);
    const jwt = await lk.createToken({
      room: 'cc-t-1',
      identity: 'human:u1',
      name: 'Sam',
      attributes: { role: 'human', userId: 'u1', displayName: 'Sam', queueKey: undefined },
      canPublish: false,
    });
    const p = payload(jwt);
    expect(p.sub).toBe('human:u1');
    expect(p.name).toBe('Sam');
    expect(p.attributes).toEqual({ role: 'human', userId: 'u1', displayName: 'Sam' });
    expect(p.video).toMatchObject({
      roomJoin: true,
      room: 'cc-t-1',
      canPublish: false,
      canSubscribe: true,
      canPublishData: true,
    });
    expect(p.exp - p.nbf).toBe(2 * 3600);
    expect(p.roomConfig).toBeUndefined();
  });

  it('embeds the agent dispatch in the token when metadata is given', async () => {
    const lk = createLiveKit(fakeClients);
    const jwt = await lk.createToken({
      room: 'cc-t-2',
      identity: 'customer:c1',
      name: 'Customer',
      attributes: { role: 'customer', displayName: 'Customer' },
      dispatchMetadata: '{"callId":"c1"}',
    });
    const p = payload(jwt);
    expect(p.video).toMatchObject({ canPublish: true });
    expect(p.roomConfig?.agents).toMatchObject([
      { agentName: 'cc-agent', metadata: '{"callId":"c1"}' },
    ]);
  });

  it('dispatches the agent explicitly and swallows delete-room errors', async () => {
    const lk = createLiveKit(fakeClients);
    await lk.dispatchAgent('room-a', '{"x":1}');
    expect(calls.dispatched).toEqual([['room-a', 'cc-agent', { metadata: '{"x":1}' }]]);
    await lk.deleteRoom('room-a');
    await expect(lk.deleteRoom('gone')).resolves.toBeUndefined();
    expect(calls.deleted).toEqual(['room-a', 'gone']);
  });
});
