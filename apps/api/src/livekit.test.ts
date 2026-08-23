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
  const calls: {
    deleted: string[];
    dispatched: unknown[];
    ctor: unknown[];
    egress: unknown[];
    stopped: string[];
  } = {
    deleted: [],
    dispatched: [],
    ctor: [],
    egress: [],
    stopped: [],
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
      egress: {
        async startRoomCompositeEgress(room, output, opts) {
          calls.egress.push([room, output, opts]);
          return { egressId: 'eg-real-1' } as never;
        },
        async stopEgress(egressId) {
          calls.stopped.push(egressId);
          if (egressId === 'gone') throw new Error('already stopped');
          return {} as never;
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
    calls.egress.length = 0;
    calls.stopped.length = 0;
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

  it('recording is unavailable without RECORDING_S3_* and no stub', async () => {
    const lk = createLiveKit(fakeClients);
    expect(await lk.startRecording('room-a')).toBeNull();
    expect(calls.egress).toEqual([]);
  });

  it('starts an audio-only S3 egress when configured and swallows stop errors', async () => {
    vi.stubEnv('RECORDING_S3_BUCKET', 'recordings');
    vi.stubEnv('RECORDING_S3_REGION', 'eu-central-1');
    vi.stubEnv('RECORDING_S3_KEY', 'k');
    vi.stubEnv('RECORDING_S3_SECRET', 's');
    const lk = createLiveKit(fakeClients);
    expect(await lk.startRecording('room-a')).toBe('eg-real-1');
    const [room, output, opts] = calls.egress[0] as [string, { file: unknown }, unknown];
    expect(room).toBe('room-a');
    expect(output.file).toBeDefined();
    expect(opts).toEqual({ audioOnly: true });
    await lk.stopRecording('eg-real-1');
    await expect(lk.stopRecording('gone')).resolves.toBeUndefined();
    expect(calls.stopped).toEqual(['eg-real-1', 'gone']);
  });

  it('RECORDING_STUB hands out fake ids and never talks to Egress', async () => {
    vi.stubEnv('RECORDING_STUB', 'true');
    const lk = createLiveKit(fakeClients);
    const id = await lk.startRecording('room-a');
    expect(id).toMatch(/^stub-egress:room-a:/);
    await lk.stopRecording(id!);
    expect(calls.egress).toEqual([]);
    expect(calls.stopped).toEqual([]);
  });
});
