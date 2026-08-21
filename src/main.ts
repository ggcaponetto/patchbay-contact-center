import { ServerOptions, cli, defineAgent, inference, voice } from '@livekit/agents';
import * as openai from '@livekit/agents-plugin-openai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.ts';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });

export default defineAgent({
  entry: async (ctx) => {
    // Set up a voice AI pipeline using AssemblyAI, Fish Audio, and the LiveKit turn detector
    const session = new voice.AgentSession({
      // Speech-to-text (STT) is your agent's ears, turning the user's speech into text that the LLM can understand
      // This uses a locally hosted Whisper model served through an OpenAI-compatible
      // /v1/audio/transcriptions endpoint (e.g. Speaches, see README). The endpoint is
      // non-streaming, so the VAD below segments the audio into utterances before transcription.
      // To switch back to a hosted model, see https://docs.livekit.io/agents/models/stt/
      stt: new openai.STT({
        baseURL: process.env.LOCAL_STT_URL ?? 'http://localhost:8000/v1',
        // Local servers ignore the key, but the plugin requires a non-empty value
        apiKey: process.env.LOCAL_STT_API_KEY ?? 'not-needed',
        model: process.env.LOCAL_STT_MODEL ?? 'Systran/faster-whisper-small',
        language: 'en',
        useRealtime: false,
      }),
      // Required to wrap the non-streaming STT above into a streaming pipeline
      vad: new inference.VAD(),

      // Text-to-speech (TTS) is your agent's voice, turning the LLM's text into speech that the user can hear
      // This uses a locally hosted model served through an OpenAI-compatible /v1/audio/speech endpoint
      // (e.g. Kokoro-FastAPI: `docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest`).
      // The server must support `response_format: 'pcm'` (24 kHz mono).
      // To switch back to a hosted model, see https://docs.livekit.io/agents/models/tts/
      tts: new openai.TTS({
        baseURL: process.env.LOCAL_TTS_URL ?? 'http://localhost:8880/v1',
        // Local servers ignore the key, but the plugin requires a non-empty value
        apiKey: process.env.LOCAL_TTS_API_KEY ?? 'not-needed',
        model: process.env.LOCAL_TTS_MODEL ?? 'kokoro',
        voice: (process.env.LOCAL_TTS_VOICE ?? 'af_heart') as openai.TTSVoices,
      }),

      turnHandling: {
        // Turn detection determines when the user is speaking and when the agent should respond.
        // The LiveKit audio turn detector is a multimodal model that encodes the user's audio
        // directly to predict end of turn. The `v1-mini` version runs fully in-process (the
        // default `v1` calls LiveKit Cloud inference).
        // See more at https://docs.livekit.io/agents/logic/turns/turn-detector/
        turnDetection: new inference.TurnDetector({ version: 'v1-mini' }),
        // Adaptive interruptions use the turn detector to tell a real interruption from a
        // backchannel like "mhm" or "right", so the agent keeps talking through the latter.
        interruption: { mode: 'adaptive' },
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: { enabled: true },
      },

      // Expressive mode injects the TTS provider's markup guide into the LLM prompt, so the model
      // emits inline delivery tags (emotion, pacing, non-verbal sounds) that the TTS renders and
      // the transcript never shows. It requires a LiveKit Inference TTS model that supports
      // markup (such as Fish Audio), so it's disabled for the local TTS server above.
      expressive: false,
    });

    // Start the session, which initializes the voice pipeline and warms up the models
    await session.start({
      agent: createAgent(),
      room: ctx.room,
      // Noise cancellation (ai-coustics / LiveKit Cloud) is a cloud media feature and is
      // intentionally omitted so the whole pipeline runs locally. To re-enable it on LiveKit
      // Cloud, see https://docs.livekit.io/transport/media/noise-cancellation/
    });

    // // Add a virtual avatar to the session, if desired
    // // For other providers, see https://docs.livekit.io/agents/models/avatar/
    // const avatar = new anam.AvatarSession({
    //   personaConfig: {
    //     name: '...',
    //     avatarId: '...', // See https://docs.livekit.io/agents/models/avatar/plugins/anam
    //   },
    // });
    // // Start the avatar and wait for it to join
    // await avatar.start(session, ctx.room);

    // Join the room and connect to the user
    await ctx.connect();

    // Greet the user on joining
    session.generateReply({
      instructions: 'Greet the user in a helpful and friendly manner.',
    });
  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'my-agent',
  }),
);
