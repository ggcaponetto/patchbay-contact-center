/**
 * Entry point of the AI agent worker.
 *
 * The worker registers with LiveKit Cloud under the agent name `cc-agent`. Whenever the
 * API creates a call with an agent dispatch (customer token room config in ai-first
 * mode, or an explicit AgentDispatch call when a human-first ring goes unanswered),
 * LiveKit hands this process a *job* for that room and the `entry` function below runs
 * for the lifetime of the call.
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
 * Run with `npm run dev:agent` (hot reload) or `npm run -w apps/agent console` (local
 * microphone, no LiveKit room).
 *
 * @see apps/agent/README.md for the lifecycle and handoff diagrams.
 * @packageDocumentation
 */
import { DispatchMetadata } from '@cc/shared';
import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  inference,
  llm,
  voice,
} from '@livekit/agents';
import { EnhancerModel, audioEnhancement } from '@livekit/plugins-ai-coustics';
import { type RemoteParticipant, RoomEvent } from '@livekit/rtc-node';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { LLM_MODEL, createAgent, summarize } from './agent.ts';
import { ApiClient } from './api.ts';
import { startTranscriber } from './transcriber.ts';

// Works from the workspace folder and from the repository root.
dotenv.config({ path: ['.env.local', '../../.env.local'] });

/** Agent name used for explicit dispatch; must match `AGENT_NAME` in `apps/api/src/livekit.ts`. */
const AGENT_NAME = 'cc-agent';
/** LiveKit Inference STT model, shared by the session and the post-handoff transcriber. */
const STT_MODEL = 'assemblyai/universal-3-5-pro';

/**
 * The agent definition loaded by the LiveKit worker. `entry` runs once per job (one call)
 * and returns when the room is torn down; see the file header for the step-by-step flow.
 */
export default defineAgent({
  entry: async (ctx: JobContext) => {
    // Dispatch metadata attached by the API when it created the call.
    const meta = DispatchMetadata.parse(JSON.parse(ctx.job.metadata));
    const api = new ApiClient(
      process.env.API_ORIGIN ?? 'http://localhost:4000',
      process.env.INTERNAL_API_SECRET ?? '',
      meta.callId,
    );
    // Identity conventions shared with the API (`apps/api/src/routes/public.ts`).
    const identity = `ai:${meta.callId}`;
    const customerIdentity = `customer:${meta.callId}`;
    // Set once a human joined; guards against double handoff and picks the participant
    // kind reported at shutdown.
    let handedOff = false;
    let stopTranscriber: (() => void) | undefined;

    // The voice pipeline. The LLM is configured on the Agent (agent.ts); everything
    // audio-related lives here.
    const session = new voice.AgentSession({
      stt: new inference.STT({ model: STT_MODEL, language: 'en' }),
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
    });

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
        stopTranscriber = startTranscriber({
          room: ctx.room,
          speechToText: new inference.STT({ model: STT_MODEL, language: 'en' }),
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
        stopTranscriber = startTranscriber({
          room: ctx.room,
          speechToText: new inference.STT({ model: STT_MODEL, language: 'en' }),
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
    const agent = createAgent({
      instructions: meta.settings.aiAgent.instructions,
      actions: {
        escalate: async ({ reason, summary }) => {
          // Fill the silence: the long-poll below can take a while.
          session.say('One moment please, I am connecting you to a colleague.');
          const outcome = await api.escalate(reason, summary, meta.settings.offerTimeoutSec);
          return outcome.outcome === 'accepted'
            ? `Tell the caller that ${outcome.agentName} is joining the call now.`
            : 'Tell the caller that no colleague is available right now, apologize, and offer to keep helping or take a message.';
        },
        endCall: async () => {
          await api.event('call.ended_by_ai');
          // Let the goodbye finish playing before the room goes away.
          setTimeout(() => ctx.shutdown(), 3000);
        },
      },
    });

    // Runs on every exit path (customer left, endCall, room deleted by the API, worker
    // stop): stop transcribing, summarize, and tell the API the call is over.
    ctx.addShutdownCallback(async () => {
      stopTranscriber?.();
      const summary = await summarize(
        new inference.LLM({ model: LLM_MODEL }),
        session.history,
      ).catch(() => '');
      await api.participant(handedOff ? 'transcriber' : 'ai', identity, true);
      await api.status('ended', summary || undefined);
    });

    // Start the pipeline before connecting so no customer audio is missed.
    await session.start({
      agent,
      room: ctx.room,
      inputOptions: { noiseCancellation: audioEnhancement({ model: EnhancerModel.QuailVfS }) },
    });
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
  },
});

// Worker process: `dev` / `start` / `console` sub-commands come from the CLI argument.
cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
