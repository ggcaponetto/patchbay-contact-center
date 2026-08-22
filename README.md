# Contact Center POC

An AI-first, multi-tenant contact center proof of concept built on [LiveKit Cloud](https://cloud.livekit.io/).

- End customers press an embeddable **"Call us"** web component on any website and talk over WebRTC.
- An **AI voice agent** answers first (configurable per tenant: `ai-first` or `human-first`) and can escalate to a human.
- **Human agents and supervisors** work from a React + MUI desk, signed in with Google via Better Auth.
- Basic **routing** (queues, agent status, offers) and a **supervisor dashboard** (live view, settings, listen-in, history).
- Every conversation (full transcript, AI and human segments, call events) is stored in **Postgres** so an LLM can act on it later.

Hard size budget: 50k non-blank source lines (`npm run loc`), POC target under 20k.

## Workspaces

| Path              | What                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `apps/agent`      | LiveKit Agents worker (Node.js). Voice pipeline on LiveKit Inference; tools for escalation and summaries |
| `apps/api`        | Fastify API: Better Auth (Google), LiveKit tokens & dispatch, routing, WebSocket for the desk, Postgres  |
| `apps/web`        | Vite + React + MUI desk for agents and supervisors                                                       |
| `apps/embed`      | `<cc-call-button>` web component, built as a single `call-button.js` script                              |
| `packages/shared` | zod schemas and types shared by every app (tenant settings, call status, WS messages)                    |

## Prerequisites

- Node.js 24+ (`.nvmrc`), npm 11+
- Docker (for Postgres)
- [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) 2.15+ and a LiveKit Cloud project
- A Google OAuth 2.0 client (Web application) with redirect URI `http://localhost:4000/api/auth/callback/google`

## Setup

```console
npm install
cp .env.example .env.local
lk cloud auth
lk app env -w -d .env.local      # writes LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
docker compose up -d             # Postgres on localhost:5432
```

Fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAILS` (your Google account) and a random `BETTER_AUTH_SECRET` in `.env.local`. The OAuth redirect URI to register in Google Cloud Console is `http://localhost:3000/api/auth/callback/google` (the web dev server proxies `/api` to the API, so cookies stay first-party).

> No Google client yet? Set `DEV_USER_EMAIL=you@example.com` in `.env.local` and every request is signed in as that user (ignored when `NODE_ENV=production`).

## Run

Each app in its own terminal:

```console
npm run dev:api      # http://localhost:4000
npm run dev:web      # http://localhost:3000
npm run dev:agent    # registers the AI agent with LiveKit Cloud
npm run dev:embed    # http://localhost:3001 demo page with the call button
```

To talk to the agent directly from the terminal without the rest of the stack: `npm run -w apps/agent console`.

## How a call flows

1. A website loads `call-button.js` (served by the API at `/embed/call-button.js` after `npm run build`) and renders `<cc-call-button key="pk_…" queue="support">`. Create keys and copy the snippet in **Settings → Call button**.
2. The button calls `POST /api/public/calls`; the API stores the call, mints a LiveKit token and — in `ai-first` mode — attaches an agent dispatch so the AI joins the room as soon as the customer connects. In `human-first` mode the API rings available agents first and dispatches the AI only if nobody picks up in time.
3. The AI agent (`apps/agent`) greets, helps, and streams every utterance to `POST /api/internal/calls/:id/transcript`. When the caller asks for a person it calls the `escalateToHuman` tool, which long-polls the API while agents of the queue are rung one at a time over the desk websocket.
4. An agent accepts in the desk and joins the same LiveKit room. Depending on the tenant setting the AI either **leaves** (the same participant keeps transcribing both sides) or **listens** (stays muted).
5. Hanging up marks the call `ended`, deletes the room and stores an LLM summary. Supervisors can listen in or take over any live call and browse the full transcript and event log afterwards.

Everything is stored in Postgres (`call`, `call_participant`, `transcript_segment`, `call_event`), ready for a future LLM to act on via MCP tools.

## Quality gates

`npm run validate` runs everything CI runs: Prettier, ESLint, `tsc`, [knip](https://knip.dev) (dead code and deps), cspell, the LOC gate, vitest with a 90% coverage threshold on logic modules, and the Vite builds. Husky runs Prettier + typecheck on commit and `validate` on push.

Other scripts: `npm test`, `npm run test:watch`, `npm run format`, `npm run lint:fix`, `npm run docs:dev` (VitePress site with the generated API reference).

The agent evals in `apps/agent/src/agent.test.ts` use an LLM as judge through LiveKit Inference; they skip automatically when `LIVEKIT_API_KEY` is not set.

## Deploying the agent

`Dockerfile` builds only the agent worker for [LiveKit Cloud agent deployment](https://docs.livekit.io/deploy/agents/): `lk agent create` / `lk agent deploy`.

## License

MIT — see [LICENSE](LICENSE).
