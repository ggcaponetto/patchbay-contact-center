/**
 * Unit tests for the job logic in `worker.ts`. Every collaborator is a small fake injected
 * through `WorkerDeps`: the job context and room are `EventEmitter`s, the session records
 * calls, and the API client is a spy. No LiveKit credentials or network are needed.
 */
import { type JobContext, initializeLogger, llm, voice } from '@livekit/agents';
import { type RemoteParticipant, RoomEvent } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentOptions } from './agent.ts';
import { ApiClient } from './api.ts';
import {
  AGENT_NAME,
  END_CALL_DELAY_MS,
  STT_MODEL,
  type WorkerApi,
  type WorkerDeps,
  createEntry,
  defaultDeps,
} from './worker.ts';

// The ai-coustics plugin loads a native binding at import time.
vi.mock('@livekit/plugins-ai-coustics', () => ({
  EnhancerModel: { QuailVfS: 'quail-vf-s' },
  audioEnhancement: vi.fn((opts: unknown) => ({ enhancement: opts })),
}));

// The inference constructors log; the SDK requires the logger to be set up first.
initializeLogger({ pretty: false, level: 'silent' });

const tick = () => new Promise((r) => setTimeout(r, 0));

const remote = (identity: string, role?: string) =>
  ({ identity, attributes: role ? { role } : {} }) as unknown as RemoteParticipant;

const metadata = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    callId: 'c1',
    tenantId: 't1',
    queueKey: 'support',
    settings: { aiAgent: { instructions: 'Acme', greeting: 'Say hi.' }, ...overrides },
  });

/** Fake `JobContext`: room events, shutdown callbacks and the connect/shutdown spies. */
const fakeCtx = (meta = metadata(), participants: RemoteParticipant[] = []) => {
  const room = Object.assign(new EventEmitter(), {
    remoteParticipants: new Map(participants.map((p) => [p.identity, p])),
    localParticipant: { setAttributes: vi.fn(async () => undefined) },
  });
  const shutdownCallbacks: (() => Promise<void>)[] = [];
  const ctx = {
    job: { metadata: meta },
    room,
    connect: vi.fn(async () => undefined),
    shutdown: vi.fn(),
    addShutdownCallback: vi.fn((cb: () => Promise<void>) => shutdownCallbacks.push(cb)),
  };
  return { ctx: ctx as unknown as JobContext, raw: ctx, room, shutdownCallbacks };
};

/** Fake `voice.AgentSession`: an emitter with spies for everything the worker calls. */
const fakeSession = () => {
  const history = llm.ChatContext.empty();
  const session = Object.assign(new EventEmitter(), {
    start: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    say: vi.fn(),
    generateReply: vi.fn(),
    interrupt: vi.fn(),
    output: { setAudioEnabled: vi.fn() },
    history,
  });
  return session;
};

const fakeApi = () => ({
  escalate: vi.fn(async () => ({ outcome: 'accepted' as const, agentName: 'Sam' })),
  transcript: vi.fn(async () => undefined),
  event: vi.fn(async () => undefined),
  participant: vi.fn(async () => undefined),
  status: vi.fn(async () => undefined),
});

const setup = (meta?: string, participants?: RemoteParticipant[]) => {
  const job = fakeCtx(meta, participants);
  const session = fakeSession();
  const api = fakeApi();
  let agentOptions: AgentOptions | undefined;
  const agent = { name: 'fake-agent' };
  const stopTranscriber = vi.fn();
  const startTranscriber = vi.fn(() => stopTranscriber);
  const summaryLlm = { chat: vi.fn(() => ({ collect: async () => ({ text: 'Summary.' }) })) };
  const deps: WorkerDeps = {
    createApi: vi.fn(() => api as unknown as WorkerApi),
    createSession: () => session as unknown as voice.AgentSession,
    createStt: vi.fn(() => ({ model: 'fake-stt' }) as never),
    createSummaryLlm: () => summaryLlm as unknown as llm.LLM,
    createAgent: vi.fn((opts: AgentOptions) => {
      agentOptions = opts;
      return agent as never;
    }),
    startTranscriber: startTranscriber as unknown as WorkerDeps['startTranscriber'],
    inputOptions: () => ({ noiseCancellation: 'nc' as never }),
    schedule: vi.fn(),
  };
  const entry = createEntry(deps);
  return {
    ...job,
    session,
    api,
    deps,
    entry,
    agent,
    startTranscriber,
    stopTranscriber,
    summaryLlm,
    actions: () => agentOptions!.actions,
    agentOptions: () => agentOptions!,
  };
};

describe('createEntry', () => {
  it('starts the session before connecting, registers itself and greets', async () => {
    const t = setup();
    await t.entry(t.ctx);
    expect(t.deps.createApi).toHaveBeenCalledWith('c1');
    expect(t.agentOptions().instructions).toBe('Acme');
    expect(t.session.start).toHaveBeenCalledWith({
      agent: t.agent,
      room: t.room,
      inputOptions: { noiseCancellation: 'nc' },
    });
    expect(t.session.start.mock.invocationCallOrder[0]).toBeLessThan(
      t.raw.connect.mock.invocationCallOrder[0]!,
    );
    expect(t.room.localParticipant.setAttributes).toHaveBeenCalledWith({ role: 'ai' });
    expect(t.api.participant).toHaveBeenCalledWith('ai', 'ai:c1');
    expect(t.api.event).toHaveBeenCalledWith('ai.joined');
    expect(t.session.generateReply).toHaveBeenCalledWith({ instructions: 'Say hi.' });
    expect(t.startTranscriber).not.toHaveBeenCalled();
  });

  it('forwards committed user and assistant messages as transcript segments', async () => {
    const t = setup();
    await t.entry(t.ctx);
    const emit = (item: unknown) =>
      t.session.emit(voice.AgentSessionEventTypes.ConversationItemAdded, { item });
    emit(llm.ChatMessage.create({ role: 'user', content: '  Hello  ' }));
    emit(llm.ChatMessage.create({ role: 'assistant', content: 'Hi there' }));
    emit(llm.ChatMessage.create({ role: 'system', content: 'ignored' }));
    emit(llm.ChatMessage.create({ role: 'user', content: '   ' }));
    emit(llm.ChatMessage.create({ role: 'user', content: [] }));
    emit(llm.FunctionCall.create({ callId: 'x', name: 'endCall', args: '{}' }));
    expect(t.api.transcript.mock.calls.map((c) => c[0])).toEqual([
      { speaker: 'customer', identity: 'customer:c1', text: 'Hello' },
      { speaker: 'ai', identity: 'ai:c1', text: 'Hi there' },
    ]);
  });

  it('shuts down when the customer disconnects, not for others', async () => {
    const t = setup();
    await t.entry(t.ctx);
    t.room.emit(RoomEvent.ParticipantDisconnected, remote('human:1', 'human'));
    expect(t.raw.shutdown).not.toHaveBeenCalled();
    t.room.emit(RoomEvent.ParticipantDisconnected, remote('customer:c1', 'customer'));
    expect(t.raw.shutdown).toHaveBeenCalledTimes(1);
  });

  it('escalate says a filler, long-polls the API and phrases the outcome', async () => {
    const t = setup(metadata({ offerTimeoutSec: 25 }));
    await t.entry(t.ctx);
    const { escalate, endCall } = t.actions();
    await expect(escalate({ reason: 'r', summary: 's' })).resolves.toBe(
      'Tell the caller that Sam is joining the call now.',
    );
    expect(t.session.say).toHaveBeenCalledWith(expect.stringMatching(/one moment/i));
    expect(t.api.escalate).toHaveBeenCalledWith('r', 's', 25);
    t.api.escalate.mockResolvedValueOnce({ outcome: 'nobody' } as never);
    await expect(escalate({ reason: 'r', summary: 's' })).resolves.toMatch(/no colleague/);

    await endCall();
    expect(t.api.event).toHaveBeenCalledWith('call.ended_by_ai');
    expect(t.deps.schedule).toHaveBeenCalledWith(expect.any(Function), END_CALL_DELAY_MS);
    expect(t.raw.shutdown).not.toHaveBeenCalled();
    (t.deps.schedule as ReturnType<typeof vi.fn>).mock.calls[0]![0]();
    expect(t.raw.shutdown).toHaveBeenCalledTimes(1);
  });

  it('on shutdown stops the transcriber, summarizes and marks the call ended', async () => {
    const t = setup();
    await t.entry(t.ctx);
    t.session.history.addMessage({ role: 'user', content: 'Hello' });
    expect(t.shutdownCallbacks).toHaveLength(1);
    await t.shutdownCallbacks[0]!();
    expect(t.summaryLlm.chat).toHaveBeenCalledTimes(1);
    expect(t.api.participant).toHaveBeenLastCalledWith('ai', 'ai:c1', true);
    expect(t.api.status).toHaveBeenCalledWith('ended', 'Summary.');
  });

  it('still reports the status when summarizing fails or yields nothing', async () => {
    const t = setup();
    await t.entry(t.ctx);
    t.summaryLlm.chat.mockImplementationOnce(() => {
      throw new Error('offline');
    });
    t.session.history.addMessage({ role: 'user', content: 'Hello' });
    await t.shutdownCallbacks[0]!();
    expect(t.api.status).toHaveBeenCalledWith('ended', undefined);
  });

  describe('handoff', () => {
    it('leave: closes the session, becomes the transcriber and covers customer and human', async () => {
      const t = setup(metadata({ handoff: { aiBehavior: 'leave' } }));
      await t.entry(t.ctx);
      const human = remote('human:1', 'human');
      t.room.remoteParticipants.set(human.identity, human);
      t.room.emit(RoomEvent.ParticipantConnected, human);
      await tick();
      expect(t.api.event).toHaveBeenCalledWith('handoff', { to: 'human:1', behavior: 'leave' });
      expect(t.session.close).toHaveBeenCalledTimes(1);
      expect(t.room.localParticipant.setAttributes).toHaveBeenLastCalledWith({
        role: 'transcriber',
      });
      expect(t.api.participant.mock.calls.slice(1)).toEqual([
        ['ai', 'ai:c1', true],
        ['transcriber', 'ai:c1'],
      ]);
      expect(t.deps.createStt).toHaveBeenCalledTimes(1);
      const opts = t.startTranscriber.mock.calls[0]![0] as unknown as Parameters<
        WorkerDeps['startTranscriber']
      >[0];
      expect(opts.room).toBe(t.room);
      expect(opts.speechToText).toEqual({ model: 'fake-stt' });
      expect(opts.include(remote('customer:c1', 'customer'))).toBe(true);
      expect(opts.include(human)).toBe(true);
      expect(opts.include(remote('supervisor:1', 'supervisor'))).toBe(false);
      opts.onSegment(human, 'I can help');
      opts.onSegment(remote('customer:c1', 'customer'), 'Thanks');
      expect(t.api.transcript.mock.calls.map((c) => c[0])).toEqual([
        { speaker: 'human', identity: 'human:1', text: 'I can help' },
        { speaker: 'customer', identity: 'customer:c1', text: 'Thanks' },
      ]);

      // A second trigger for the same human is a no-op.
      t.room.emit(RoomEvent.ParticipantAttributesChanged, {}, human);
      t.room.emit(RoomEvent.ParticipantConnected, remote('human:2', 'human'));
      await tick();
      expect(t.session.close).toHaveBeenCalledTimes(1);

      // Shutdown reports the transcriber as the participant that left.
      await t.shutdownCallbacks[0]!();
      expect(t.stopTranscriber).toHaveBeenCalledTimes(1);
      expect(t.api.participant).toHaveBeenLastCalledWith('transcriber', 'ai:c1', true);
    });

    it('listen: mutes the session and transcribes the human only', async () => {
      const t = setup(metadata({ handoff: { aiBehavior: 'listen' } }));
      await t.entry(t.ctx);
      const human = remote('human:1');
      // Connected without the role; the attribute arrives afterwards.
      t.room.emit(RoomEvent.ParticipantConnected, human);
      t.room.emit(RoomEvent.ParticipantAttributesChanged, {}, human);
      await tick();
      expect(t.api.event).not.toHaveBeenCalledWith('handoff', expect.anything());
      const withRole = remote('human:1', 'human');
      t.room.remoteParticipants.set('human:1', withRole);
      t.room.emit(RoomEvent.ParticipantAttributesChanged, {}, human);
      await tick();
      expect(t.api.event).toHaveBeenCalledWith('handoff', { to: 'human:1', behavior: 'listen' });
      expect(t.session.interrupt).toHaveBeenCalledTimes(1);
      expect(t.session.output.setAudioEnabled).toHaveBeenCalledWith(false);
      expect(t.session.close).not.toHaveBeenCalled();
      expect(t.room.localParticipant.setAttributes).toHaveBeenCalledTimes(1);
      const opts = t.startTranscriber.mock.calls[0]![0] as unknown as Parameters<
        WorkerDeps['startTranscriber']
      >[0];
      expect(opts.include(withRole)).toBe(true);
      expect(opts.include(remote('customer:c1', 'customer'))).toBe(false);
      opts.onSegment(withRole, 'Hello');
      expect(t.api.transcript).toHaveBeenCalledWith({
        speaker: 'human',
        identity: 'human:1',
        text: 'Hello',
      });
    });

    it('handles a human that is already in the room at start', async () => {
      const t = setup(metadata(), [remote('customer:c1', 'customer'), remote('human:9', 'human')]);
      await t.entry(t.ctx);
      await tick();
      expect(t.api.event).toHaveBeenCalledWith('handoff', { to: 'human:9', behavior: 'leave' });
    });
  });
});

describe('defaultDeps', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('builds the production collaborators from the environment', () => {
    vi.stubEnv('LIVEKIT_API_KEY', 'key');
    vi.stubEnv('LIVEKIT_API_SECRET', 'secret');
    vi.stubEnv('API_ORIGIN', 'http://api.test');
    vi.stubEnv('INTERNAL_API_SECRET', 'internal-secret');
    const deps = defaultDeps();
    expect(deps.createApi('c1')).toBeInstanceOf(ApiClient);
    expect((deps.createStt() as unknown as { model: string }).model).toBe(STT_MODEL);
    expect(deps.createSummaryLlm()).toBeDefined();
    expect(deps.createSession()).toBeInstanceOf(voice.AgentSession);
    expect(deps.inputOptions()).toEqual({
      noiseCancellation: { enhancement: { model: 'quail-vf-s' } },
    });
    expect(AGENT_NAME).toBe('cc-agent');
  });

  it('falls back to localhost and an empty secret, and schedules with setTimeout', async () => {
    vi.stubEnv('API_ORIGIN', '');
    vi.stubEnv('INTERNAL_API_SECRET', '');
    vi.unstubAllEnvs();
    delete process.env.API_ORIGIN;
    delete process.env.INTERNAL_API_SECRET;
    const deps = defaultDeps();
    const api = deps.createApi('c1') as unknown as { baseUrl: string; secret: string };
    expect(api.baseUrl).toBe('http://localhost:4000');
    expect(api.secret).toBe('');
    vi.useFakeTimers();
    const fn = vi.fn();
    deps.schedule(fn, 10);
    vi.advanceTimersByTime(10);
    vi.useRealTimers();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// `createEntry()` without arguments must not touch the network either; only the
// factories do, and they are not called until a job arrives.
describe('createEntry defaults', () => {
  it('returns a function', () => {
    expect(typeof createEntry()).toBe('function');
  });
});
