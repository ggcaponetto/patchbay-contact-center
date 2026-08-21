<a href="https://livekit.io/">
  <img src="./.github/assets/livekit-mark.png" alt="LiveKit logo" width="100" height="100">
</a>

# LiveKit Agents Starter - Node.js

A complete starter project for building voice AI apps with [LiveKit Agents for Node.js](https://github.com/livekit/agents-js) and [LiveKit Cloud](https://cloud.livekit.io/).

The starter project includes:

- A simple voice AI assistant, ready for extension and customization
- A fully self-hosted voice AI pipeline, with no cloud dependencies by default (see [Fully self-hosted setup](#fully-self-hosted-setup))
  - LLM: Gemma 4 (4B) served by [Ollama](https://ollama.com)
  - STT: faster-whisper served by [Speaches](https://speaches.ai)
  - TTS: [Kokoro](https://github.com/remsky/Kokoro-FastAPI)
  - VAD and turn detection run in-process
  - Every component is swappable for hosted models from [LiveKit Inference](https://docs.livekit.io/agents/models/inference) or the [plugin ecosystem](https://docs.livekit.io/agents/models) by editing `src/main.ts` and `src/agent.ts`
- Eval suite based on the LiveKit Agents [testing & evaluation framework](https://docs.livekit.io/agents/start/testing)
- [LiveKit Turn Detector](https://docs.livekit.io/agents/logic/turns/turn-detector/), an end-of-turn model that listens to the user's audio directly, combining semantic understanding with acoustic cues for state-of-the-art accuracy across 14 languages
- A Dockerfile ready for [production deployment to LiveKit Cloud](https://docs.livekit.io/deploy/agents/)

This starter app is compatible with any [custom web/mobile frontend](https://docs.livekit.io/frontends/) or [telephony](https://docs.livekit.io/telephony/).

## Using coding agents

This project is designed to work with coding agents like [Claude Code](https://claude.com/product/claude-code), [Cursor](https://www.cursor.com/), and [Codex](https://openai.com/codex/).

For your convenience, LiveKit offers both a CLI and an [MCP server](https://docs.livekit.io/reference/developer-tools/docs-mcp/) that can be used to browse and search its documentation. The [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) (`lk docs`) works with any coding agent that can run shell commands. Install it for your platform:

**macOS:**

```console
brew install livekit-cli
```

**Linux:**

```console
curl -sSL https://get.livekit.io/cli | bash
```

**Windows:**

```console
winget install LiveKit.LiveKitCLI
```

The `lk docs` subcommand requires version 2.15.0 or higher. Check your version with `lk --version` and update if needed. Once installed, your coding agent can search and browse LiveKit documentation directly from the terminal:

```console
lk docs search "voice agents"
lk docs get-page /agents/start/voice-ai-quickstart
```

See the [Coding agent support](https://docs.livekit.io/intro/coding-agents/) guide for more details, including MCP server setup.

The project includes a complete [AGENTS.md](AGENTS.md) file for these assistants. You can modify this file to suit your needs. To learn more about this file, see [https://agents.md](https://agents.md).

## Dev Setup

Create a project from this template with the LiveKit CLI (recommended):

```bash
lk cloud auth
lk agent init my-agent --template agent-starter-node
```

The CLI clones the template and configures your environment. Then follow the rest of this guide from [Run the agent](#run-the-agent).

This project uses [pnpm](https://pnpm.io/) as the package manager.

<details>
<summary>Alternative: Manual setup without the CLI</summary>

Clone the repository and install dependencies:

```console
cd agent-starter-node
pnpm install
```

Sign up for [LiveKit Cloud](https://cloud.livekit.io/) then set up the environment by copying `.env.example` to `.env.local` and filling in the required keys:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

You can load the LiveKit environment automatically using the [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/):

```bash
lk cloud auth
lk app env -w -d .env.local
```

</details>

## Fully self-hosted setup

This project is configured to run every part of the voice pipeline on your own machine. Nothing leaves your computer: the LiveKit server, STT, LLM, TTS, VAD and turn detection all run locally.

| Component      | Runs as                                                                 | Port  | Configured in                  |
| -------------- | ----------------------------------------------------------------------- | ----- | ------------------------------ |
| LiveKit server | Docker `livekit/livekit-server` (dev mode)                              | 7880  | `.env.local`                   |
| LLM            | [Ollama](https://ollama.com) `gemma4:e4b`                               | 11434 | `src/agent.ts` (`LOCAL_LLM_*`) |
| STT            | Docker [Speaches](https://speaches.ai) + `Systran/faster-whisper-small` | 8000  | `src/main.ts` (`LOCAL_STT_*`)  |
| TTS            | Docker [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)       | 8880  | `src/main.ts` (`LOCAL_TTS_*`)  |
| VAD            | In-process (`inference.VAD`, bundled native binding)                    | —     | `src/main.ts`                  |
| Turn detection | In-process (`inference.TurnDetector({ version: 'v1-mini' })`)           | —     | `src/main.ts`                  |

The STT, LLM and TTS services all speak the OpenAI API, so the agent uses `@livekit/agents-plugin-openai` pointed at `localhost`. Any other OpenAI-compatible server works too: change the `LOCAL_*_URL` / `LOCAL_*_MODEL` variables in `.env.local`.

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Ollama](https://ollama.com/download) **0.20 or newer** (Gemma 4 needs a recent release; check with `ollama -v`)
- Node.js 22+ and pnpm 10+ (`npm i -g pnpm@10`)
- An NVIDIA GPU is optional. Everything runs on CPU, but the LLM and STT are noticeably faster with one.

### 1. Start the LiveKit server

```console
docker run -d --name livekit-server   -p 7880:7880 -p 7881:7881 -p 7882:7882/udp   livekit/livekit-server --dev --bind 0.0.0.0
```

Dev mode uses the fixed credentials `devkey` / `secret`. Put them in `.env.local`:

```env
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

> Dev mode is for local use only. For a shared or production deployment, follow the [self-hosting guide](https://docs.livekit.io/transport/self-hosting/local/) and generate real keys.

### 2. Start the LLM (Ollama)

```console
ollama pull gemma4:e4b
```

Ollama serves on `http://localhost:11434` automatically. Pick a different model with `LOCAL_LLM_MODEL` (for example `gemma4:12b` if you have the VRAM; smaller models give lower latency).

### 3. Start STT (Speaches)

```console
docker run -d --name speaches -p 8000:8000   -v hf-hub-cache:/home/ubuntu/.cache/huggingface/hub   ghcr.io/speaches-ai/speaches:latest-cpu
curl -X POST http://localhost:8000/v1/models/Systran/faster-whisper-small
```

Use the `latest-cuda` image with `--gpus all` for NVIDIA GPUs. For English-only, `Systran/faster-distil-whisper-small.en` is faster; set it in `LOCAL_STT_MODEL` and download it the same way.

### 4. Start TTS (Kokoro)

```console
docker run -d --name kokoro-tts -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

Use `kokoro-fastapi-gpu` with `--gpus all` for NVIDIA GPUs. List voices with `curl http://localhost:8880/v1/audio/voices` and pick one with `LOCAL_TTS_VOICE`.

> If the pull fails with `denied`, you have a stale `ghcr.io` login in Docker. Run `docker logout ghcr.io` and retry.

### 5. Run the agent

```console
pnpm install
pnpm run dev
```

Then connect a frontend (see [Frontend & Telephony](#frontend--telephony)) to `ws://localhost:7880` using a token signed with `devkey` / `secret`. The quickest way is the LiveKit CLI: `lk token create --api-key devkey --api-secret secret --join --room test --identity me`, or run `agent-starter-react` with the same three `LIVEKIT_*` values in its `.env.local`.

### Smoke-testing the services

Check each service independently before debugging the agent:

```console
curl http://localhost:7880                                              # LiveKit: "OK"
curl http://localhost:11434/v1/models                                   # Ollama: lists gemma4:e4b
curl http://localhost:8880/v1/audio/speech -H "Content-Type: application/json"   -d '{"model":"kokoro","voice":"af_heart","input":"Hello there","response_format":"wav"}' -o hello.wav
curl http://localhost:8000/v1/audio/transcriptions -F file=@hello.wav -F model=Systran/faster-whisper-small
```

The last command should print `{"text":"Hello there"}`.

### Tests

`pnpm test` also runs fully locally: the LLM-as-judge in `src/agent.test.ts` uses the same Ollama model as the agent.

### Going back to LiveKit Cloud

Swap `.env.local` for your cloud project's values (`lk app env -w -d .env.local`) and replace the `openai.*` constructors in `src/main.ts` / `src/agent.ts` with `inference.*` models, as documented in the [models guide](https://docs.livekit.io/agents/models/). Noise cancellation and expressive TTS are LiveKit Cloud features and can be re-enabled at the same time.

## Run the agent

To run the agent during development, use the `dev` command:

```console
pnpm run dev
```

In production, use the `start` command:

```console
pnpm run start
```

## Frontend & Telephony

Get started quickly with our pre-built frontend starter apps, or add telephony support:

| Platform         | Link                                                                                                                | Description                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Web**          | [`livekit-examples/agent-starter-react`](https://github.com/livekit-examples/agent-starter-react)                   | Web voice AI assistant with React & Next.js        |
| **iOS/macOS**    | [`livekit-examples/agent-starter-swift`](https://github.com/livekit-examples/agent-starter-swift)                   | Native iOS, macOS, and visionOS voice AI assistant |
| **Flutter**      | [`livekit-examples/agent-starter-flutter`](https://github.com/livekit-examples/agent-starter-flutter)               | Cross-platform voice AI assistant app              |
| **React Native** | [`livekit-examples/voice-assistant-react-native`](https://github.com/livekit-examples/voice-assistant-react-native) | Native mobile app with React Native & Expo         |
| **Android**      | [`livekit-examples/agent-starter-android`](https://github.com/livekit-examples/agent-starter-android)               | Native Android app with Kotlin & Jetpack Compose   |
| **Web Embed**    | [`livekit-examples/agent-starter-embed`](https://github.com/livekit-examples/agent-starter-embed)                   | Voice AI widget for any website                    |
| **Telephony**    | [Documentation](https://docs.livekit.io/telephony/)                                                                 | Add inbound or outbound calling to your agent      |

For advanced customization, see the [complete frontend guide](https://docs.livekit.io/frontends/).

## Using this template repo for your own project

Once you've started your own project based on this repo, you should:

1. **Check in your `pnpm-lock.yaml`**: This file is currently untracked for the template, but you should commit it to your repository for reproducible builds and proper configuration management. (The same applies to `livekit.toml`, if you run your agents in LiveKit Cloud)

2. **Remove the git tracking test**: Delete the "Check files not tracked in git" step from `.github/workflows/tests.yml` since you'll now want this file to be tracked. These are just there for development purposes in the template repo itself.

## Deploying to production

This project is production-ready and includes a working `Dockerfile`. To deploy it to LiveKit Cloud or another environment, see the [deploying to production](https://docs.livekit.io/deploy/agents/) guide.

## Self-hosted LiveKit

This project runs against a self-hosted LiveKit server by default; see [Fully self-hosted setup](#fully-self-hosted-setup). For production self-hosting, see the [self-hosting](https://docs.livekit.io/transport/self-hosting/local/) guide.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
