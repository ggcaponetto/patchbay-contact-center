/**
 * Job logic of the AI agent worker, separated from the process entry point (`main.ts`)
 * so that it can be unit-tested with fakes.
 *
 * {@link createEntry} returns the `entry(ctx)` function that LiveKit runs once per job
 * (one call). Every collaborator that needs the network, LiveKit credentials or native
 * code (the voice session, STT, the summary LLM, the API client, the transcriber, the
 * noise canceller, the timer) is injected through {@link WorkerDeps};
 * {@link defaultDeps} supplies the production implementations.
 *
 * Responsibilities of one job:
 * 1. Parse the {@link DispatchMetadata} the API attached to the dispatch.
 * 2. Build a `voice.AgentSession` (STT / TTS / turn detection from LiveKit Inference)
 *    around the agent from `agent.ts`, join the room and speak the greeting.
 * 3. Stream every committed user/assistant message to the API as a transcript segment.
 * 4. Watch for a human agent joining and apply the tenant's handoff behavior
 *    (`leave` or `listen`), switching to the raw-track transcriber where needed.
 * 5. Shut down when the customer leaves or the LLM calls `endCall`; on shutdown,
 *    summarize the conversation and mark the call `ended`.
 *
 * @see apps/agent/README.md for the lifecycle and handoff diagrams.
 * @packageDocumentation
 */
import { DispatchMetadata, baseLanguage } from '@cc/shared';
import { type JobContext, inference, llm, type stt, voice } from '@livekit/agents';
import { EnhancerModel, audioEnhancement } from '@livekit/plugins-ai-coustics';
import { type RemoteParticipant, RoomEvent } from '@livekit/rtc-node';
import { LLM_MODEL, createAgent, summarize } from './agent.ts';
import { ApiClient } from './api.ts';
import { startTranscriber } from './transcriber.ts';

/** Agent name used for explicit dispatch; must match `AGENT_NAME` in `apps/api/src/livekit.ts`. */
export const AGENT_NAME = 'cc-agent';
/** LiveKit Inference STT model, shared by the session and the post-handoff transcriber. */
export const STT_MODEL = 'assemblyai/universal-3-5-pro';
/** Delay between the `endCall` tool and the shutdown, so the goodbye finishes playing. */
export const END_CALL_DELAY_MS = 3000;

/** Subset of {@link ApiClient} used by the worker; lets tests inject a recording fake. */
export type WorkerApi = Pick<
  ApiClient,
  'escalate' | 'transcript' | 'event' | 'participant' | 'status'
>;

/**
 * Everything the job logic needs from the outside world. Each factory is called at most
 * once per job (STT twice at most: session and transcriber); see {@link defaultDeps}.
 */
export type WorkerDeps = {
  /** API client bound to the call id. */
  createApi: (callId: string) => WorkerApi;
  /**
   * The voice pipeline (STT, TTS, turn handling) for a call in `language` (a base tag
   * such as `de`; `en` by default). The LLM lives on the agent.
   */
  createSession: (language: string) => voice.AgentSession;
  /** Fresh STT for the post-handoff transcriber (streams are not shareable). */
  createStt: (language: string) => stt.STT;
  /** LLM used by {@link summarize} at shutdown. */
  createSummaryLlm: () => llm.LLM;
  /** Builds the agent; defaults to {@link createAgent}. */
  createAgent: typeof createAgent;
  /** Raw-track transcriber; defaults to {@link startTranscriber}. */
  startTranscriber: typeof startTranscriber;
  /** Input options for `session.start` (noise cancellation); `{}` disables it. */
  inputOptions: () => Partial<voice.RoomInputOptions>;
  /** Timer used to delay the shutdown after `endCall`; defaults to `setTimeout`. */
  schedule: (fn: () => void, ms: number) => void;
};

/**
 * Production implementations of {@link WorkerDeps}: LiveKit Inference models, the
 * ai-coustics noise canceller and the real {@link ApiClient} configured from
 * `API_ORIGIN` / `INTERNAL_API_SECRET`.
 *
 * @returns The dependency set used by `main.ts`.
 */
export function defaultDeps(): WorkerDeps {
  const createStt = (language: string) => new inference.STT({ model: STT_MODEL, language });
  return {
    createApi: (callId) =>
      new ApiClient(
        process.env.API_ORIGIN ?? 'http://localhost:4000',
        process.env.INTERNAL_API_SECRET ?? '',
        callId,
      ),
    createSession: (language) =>
      new voice.AgentSession({
        stt: createStt(language),
        tts: new inference.TTS({
          model: 'fishaudio/s2.1-pro',
          voice: 'fa4c9eb3dccc4806b382b40d61c6b10a',
        }),
        turnHandling: {
          // LiveKit's end-of-turn model instead of plain VAD silence.
          turnDetection: new inference.TurnDetector(),
          // Lets the caller interrupt, with sensitivity adapted to how often they do.
          interruption: { mode: 'adaptive' },
          // Start generating the reply before the turn is confirmed over; lowers latency.
          preemptiveGeneration: { enabled: true },
        },
        // Lets the LLM steer TTS prosody (requires a TTS model that supports it).
        expressive: true,
      }),
    createStt,
    createSummaryLlm: () => new inference.LLM({ model: LLM_MODEL }),
    createAgent,
    startTranscriber,
    inputOptions: () => ({
      noiseCancellation: audioEnhancement({ model: EnhancerModel.QuailVfS }),
    }),
    schedule: (fn, ms) => void setTimeout(fn, ms),
  };
}

/**
 * Builds the per-job `entry` function for `defineAgent`.
 *
 * @param deps - Collaborators; defaults to {@link defaultDeps}. Tests pass fakes.
 * @returns The function LiveKit runs for every job; it returns once the call is set up
 *   and the greeting is requested (the room keeps the job alive until shutdown).
 * @example
 * ```ts
 * export default defineAgent({ entry: createEntry() });
 * ```
 */
export function createEntry(deps: WorkerDeps = defaultDeps()): (ctx: JobContext) => Promise<void> {
  return async (ctx) => {
    // Dispatch metadata attached by the API when it created the call.
    const meta = DispatchMetadata.parse(JSON.parse(ctx.job.metadata));
    const api = deps.createApi(meta.callId);
    // Identity conventions shared with the API (`apps/api/src/routes/public.ts`).
    const identity = `ai:${meta.callId}`;
    const customerIdentity = `customer:${meta.callId}`;
    // Set once a human joined; guards against double handoff and picks the participant
    // kind reported at shutdown.
    let handedOff = false;
    let stopTranscriber: (() => void) | undefined;

    // The call's language drives STT (and the post-handoff transcribers); `en` otherwise.
    const language = (meta.language && baseLanguage(meta.language)) || 'en';
    const session = deps.createSession(language);

    // Every committed user/assistant message goes to the API as a transcript segment.
    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      if (!(event.item instanceof llm.ChatMessage)) return;
      const text = event.item.textContent?.trim();
      if (!text || (event.item.role !== 'user' && event.item.role !== 'assistant')) return;
      const isUser = event.item.role === 'user';
      void api.transcript({
        speaker: isUser ? 'customer' : 'ai',
        identity: isUser ? customerIdentity : identity,
        text,
      });
    });

    /** `role` attribute the API baked into the participant's token (see ParticipantAttributes). */
    const roleOf = (p: RemoteParticipant) => p.attributes['role'];

    /**
     * A human agent joined. Depending on tenant settings the AI either leaves the
     * conversation (session closed, the same participant keeps transcribing) or
     * stays muted and keeps listening to the customer.
     *
     * Idempotent: the three triggers below (participant connected, attributes changed,
     * already present at start) may all fire for the same human.
     */
    const onHumanJoined = async (human: RemoteParticipant) => {
      if (handedOff) return;
      handedOff = true;
      const behavior = meta.settings.handoff.aiBehavior;
      await api.event('handoff', { to: human.identity, behavior });
      if (behavior === 'listen') {
        // Stop mid-sentence and never play audio again; the session keeps running, so
        // the customer is still transcribed through ConversationItemAdded above.
        session.interrupt();
        session.output.setAudioEnabled(false);
        // The session only transcribes the customer; cover the human agent too.
        stopTranscriber = deps.startTranscriber({
          room: ctx.room,
          speechToText: deps.createStt(language),
          include: (p) => p.identity === human.identity,
          onSegment: (p, text) =>
            void api.transcript({ speaker: 'human', identity: p.identity, text }),
        });
      } else {
        // `leave`: tear down the voice pipeline but stay in the room as a transcriber so
        // the desk transcript covers the human conversation as well.
        await session.close();
        await ctx.room.localParticipant?.setAttributes({ role: 'transcriber' });
        await api.participant('ai', identity, true);
        await api.participant('transcriber', identity);
        stopTranscriber = deps.startTranscriber({
          room: ctx.room,
          speechToText: deps.createStt(language),
          include: (p) => roleOf(p) === 'customer' || roleOf(p) === 'human',
          onSegment: (p, text) =>
            void api.transcript({
              speaker: roleOf(p) === 'human' ? 'human' : 'customer',
              identity: p.identity,
              text,
            }),
        });
      }
    };
    // Humans normally arrive with the attribute already set; the second listener covers
    // clients that connect first and set attributes afterwards.
    ctx.room.on(RoomEvent.ParticipantConnected, (p) => {
      if (roleOf(p) === 'human') void onHumanJoined(p);
    });
    ctx.room.on(RoomEvent.ParticipantAttributesChanged, (_changed, p) => {
      const remote = ctx.room.remoteParticipants.get(p.identity);
      if (remote && roleOf(remote) === 'human') void onHumanJoined(remote);
    });
    ctx.room.on(RoomEvent.ParticipantDisconnected, (p) => {
      // The customer hung up: nothing left to do for this job.
      if (p.identity === customerIdentity) ctx.shutdown();
    });

    // Real implementations of the tool side effects declared in agent.ts.
    const agent = deps.createAgent({
      instructions: meta.settings.aiAgent.instructions,
      skills: meta.settings.skills,
      ...(meta.language ? { language: meta.language } : {}),
      actions: {
        escalate: async ({ reason, summary, skills, language: spoken }) => {
          // Fill the silence: the long-poll below can take a while.
          session.say('One moment please, I am connecting you to a colleague.');
          const outcome = await api.escalate({
            reason,
            summary,
            ringSec: meta.settings.offerTimeoutSec,
            ...(skills?.length ? { skills } : {}),
            ...(spoken ? { language: spoken } : {}),
          });
          return outcome.outcome === 'accepted'
            ? `Tell the caller that ${outcome.agentName} is joining the call now.`
            : 'Tell the caller that no colleague is available right now, apologize, and offer to keep helping or take a message.';
        },
        endCall: async () => {
          await api.event('call.ended_by_ai');
          // Let the goodbye finish playing before the room goes away.
          deps.schedule(() => ctx.shutdown(), END_CALL_DELAY_MS);
        },
      },
    });

    // Runs on every exit path (customer left, endCall, room deleted by the API, worker
    // stop): stop transcribing, summarize, and tell the API the call is over.
    ctx.addShutdownCallback(async () => {
      stopTranscriber?.();
      const summary = await summarize(deps.createSummaryLlm(), session.history).catch(() => '');
      await api.participant(handedOff ? 'transcriber' : 'ai', identity, true);
      await api.status('ended', summary || undefined);
    });

    // Start the pipeline before connecting so no customer audio is missed.
    await session.start({ agent, room: ctx.room, inputOptions: deps.inputOptions() });
    await ctx.connect();
    await ctx.room.localParticipant?.setAttributes({ role: 'ai' });
    await api.participant('ai', identity);
    await api.event('ai.joined');
    // A human may already be in the room if someone joined before the worker connected.
    for (const p of ctx.room.remoteParticipants.values()) {
      if (roleOf(p) === 'human') void onHumanJoined(p);
    }

    // First utterance; the tenant's greeting is an instruction, not a fixed sentence.
    session.generateReply({ instructions: meta.settings.aiAgent.greeting });
  };
}
