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

dotenv.config({ path: ['.env.local', '../../.env.local'] });

const AGENT_NAME = 'cc-agent';
const STT_MODEL = 'assemblyai/universal-3-5-pro';

export default defineAgent({
  entry: async (ctx: JobContext) => {
    // Dispatch metadata attached by the API when it created the call.
    const meta = DispatchMetadata.parse(JSON.parse(ctx.job.metadata));
    const api = new ApiClient(
      process.env.API_ORIGIN ?? 'http://localhost:4000',
      process.env.INTERNAL_API_SECRET ?? '',
      meta.callId,
    );
    const identity = `ai:${meta.callId}`;
    const customerIdentity = `customer:${meta.callId}`;
    let handedOff = false;
    let stopTranscriber: (() => void) | undefined;

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: STT_MODEL, language: 'en' }),
      tts: new inference.TTS({
        model: 'fishaudio/s2.1-pro',
        voice: 'fa4c9eb3dccc4806b382b40d61c6b10a',
      }),
      turnHandling: {
        turnDetection: new inference.TurnDetector(),
        interruption: { mode: 'adaptive' },
        preemptiveGeneration: { enabled: true },
      },
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

    const roleOf = (p: RemoteParticipant) => p.attributes['role'];

    /**
     * A human agent joined. Depending on tenant settings the AI either leaves the
     * conversation (session closed, the same participant keeps transcribing) or
     * stays muted and keeps listening to the customer.
     */
    const onHumanJoined = async (human: RemoteParticipant) => {
      if (handedOff) return;
      handedOff = true;
      const behavior = meta.settings.handoff.aiBehavior;
      await api.event('handoff', { to: human.identity, behavior });
      if (behavior === 'listen') {
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

    const agent = createAgent({
      instructions: meta.settings.aiAgent.instructions,
      actions: {
        escalate: async ({ reason, summary }) => {
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

    ctx.addShutdownCallback(async () => {
      stopTranscriber?.();
      const summary = await summarize(
        new inference.LLM({ model: LLM_MODEL }),
        session.history,
      ).catch(() => '');
      await api.participant(handedOff ? 'transcriber' : 'ai', identity, true);
      await api.status('ended', summary || undefined);
    });

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: { noiseCancellation: audioEnhancement({ model: EnhancerModel.QuailVfS }) },
    });
    await ctx.connect();
    await ctx.room.localParticipant?.setAttributes({ role: 'ai' });
    await api.participant('ai', identity);
    await api.event('ai.joined');
    for (const p of ctx.room.remoteParticipants.values()) {
      if (roleOf(p) === 'human') void onHumanJoined(p);
    }

    session.generateReply({ instructions: meta.settings.aiAgent.greeting });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
