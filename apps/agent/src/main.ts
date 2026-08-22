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
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { LLM_MODEL, createAgent, summarize } from './agent.ts';
import { ApiClient } from './api.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });

const AGENT_NAME = 'cc-agent';

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

    const session = new voice.AgentSession({
      stt: new inference.STT({ model: 'assemblyai/universal-3-5-pro', language: 'en' }),
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
        identity: isUser ? `customer:${meta.callId}` : identity,
        text,
      });
    });

    const agent = createAgent({
      instructions: meta.settings.aiAgent.instructions,
      actions: {
        escalate: async ({ reason, summary }) => {
          await api.event('escalation.requested', { reason, summary });
          await api.status('waiting_human', summary);
          return 'Tell the caller you are connecting them to a colleague and to stay on the line.';
        },
        endCall: async () => {
          await api.event('call.ended_by_ai');
          // Let the goodbye finish playing before the room goes away.
          setTimeout(() => ctx.shutdown(), 3000);
        },
      },
    });

    ctx.addShutdownCallback(async () => {
      const summary = await summarize(
        new inference.LLM({ model: LLM_MODEL }),
        session.history,
      ).catch(() => '');
      await api.participant('ai', identity, true);
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

    session.generateReply({ instructions: meta.settings.aiAgent.greeting });
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
