<div align="center">

# Patchbay Contact Center

**An AI-first contact center on LiveKit Cloud — the AI answers, humans take over.**

A "Call us" button for any website, a voice AI that picks up first, a React desk where
human agents and supervisors take over live calls, and every conversation stored in
Postgres for the next LLM to act on.

[![CI](https://github.com/ggcaponetto/patchbay-contact-center/actions/workflows/ci.yml/badge.svg)](https://github.com/ggcaponetto/patchbay-contact-center/actions/workflows/ci.yml)
[![Docs](https://github.com/ggcaponetto/patchbay-contact-center/actions/workflows/docs.yml/badge.svg)](https://ggcaponetto.github.io/patchbay-contact-center/)
[![SAST](https://github.com/ggcaponetto/patchbay-contact-center/actions/workflows/sast.yml/badge.svg?branch=main)](https://github.com/ggcaponetto/patchbay-contact-center/actions/workflows/sast.yml)
[![DAST](https://github.com/ggcaponetto/patchbay-contact-center/actions/workflows/dast.yml/badge.svg?branch=main)](https://github.com/ggcaponetto/patchbay-contact-center/actions/workflows/dast.yml)
[![Release](https://img.shields.io/github/v/release/ggcaponetto/patchbay-contact-center?sort=semver)](https://github.com/ggcaponetto/patchbay-contact-center/releases)
[![codecov](https://codecov.io/gh/ggcaponetto/patchbay-contact-center/branch/main/graph/badge.svg)](https://codecov.io/gh/ggcaponetto/patchbay-contact-center)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=ggcaponetto_livekit-playground&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=ggcaponetto_livekit-playground)
[![Lines of Code](https://sonarcloud.io/api/project_badges/measure?project=ggcaponetto_livekit-playground&metric=ncloc)](https://sonarcloud.io/summary/overall?id=ggcaponetto_livekit-playground)
[![E2E](https://github.com/ggcaponetto/patchbay-contact-center/actions/workflows/e2e-nightly.yml/badge.svg)](https://github.com/ggcaponetto/patchbay-contact-center/actions/workflows/e2e-nightly.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/ggcaponetto/patchbay-contact-center/blob/main/LICENSE)
[![Node ≥ 24](https://img.shields.io/badge/node-%E2%89%A5%2024-brightgreen)](https://nodejs.org)
[![LiveKit Agents](https://img.shields.io/badge/LiveKit%20Agents-1.7-0A84FF)](https://docs.livekit.io/agents/)

**[Getting started](docs/guide/getting-started.md)** ·
[Documentation](https://ggcaponetto.github.io/patchbay-contact-center/) ·
[Architecture](docs/guide/architecture.md) ·
[Roadmap](docs/guide/roadmap.md) ·
[API Reference](https://ggcaponetto.github.io/patchbay-contact-center/docs/api/)

</div>

---

## What it does

- **Embeddable call button** — `<cc-call-button>` web component (React inside the shadow root), one `<script>` tag, WebRTC audio through LiveKit.
- **Multilingual** — desk and call button in English, German and Italian (react-i18next); the desk remembers the choice, the button follows its `language` attribute or the page.
- **AI answers first** — a LiveKit Agents voice pipeline (STT → LLM → TTS, turn detection, noise cancellation) greets the caller, helps, and calls an `escalateToHuman` tool when a person is needed. Per tenant you can flip to **human-first** with the AI as fallback.
- **Human agents & supervisors** — React + MUI desk with Google sign-in (Better Auth): availability, ring-one-agent-at-a-time routing, in-call panel with live transcript, supervisor dashboard, listen-in / take-over, settings, history.
- **Same-room handoff** — the human joins the customer's LiveKit room; the AI either leaves (and keeps transcribing) or stays muted and listens.
- **Everything persisted** — calls, participants, full transcripts (AI and human segments) and an event log in Postgres, plus an LLM summary per call. Multi-tenant from day one.

## How it works

```mermaid
sequenceDiagram
  autonumber
  participant C as Customer (embed button)
  participant API as API (Fastify)
  participant LK as LiveKit Cloud
  participant AI as AI agent worker
  participant D as Desk (agent)
  C->>API: POST /api/public/calls (embed key)
  API-->>C: room token with agent dispatch
  C->>LK: join room
  LK->>AI: dispatch job (call metadata)
  AI-->>C: greets, helps (transcript → API)
  C->>AI: "I want to talk to a person"
  AI->>API: escalate (long-poll)
  API-->>D: ws call.offer (ring)
  D->>API: accept → human token
  D->>LK: join the same room
  AI-->>API: handoff (leave or listen)
  D->>API: hang up → call ended, summary stored
```

Deeper dives: [Architecture](docs/guide/architecture.md) · [Call lifecycle](docs/guide/call-lifecycle.md) · per-app docs next to the code: [API](apps/api/README.md) · [AI agent](apps/agent/README.md) · [Web desk](apps/web/README.md) · [Embed](apps/embed/README.md) · [Shared contracts](packages/shared/README.md) · [i18n runtime](packages/i18n/README.md).

## Getting started

**Prerequisites:** Node ≥ 24 and npm ≥ 11, Docker (Postgres), the [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) with a [LiveKit Cloud](https://cloud.livekit.io/) project, and optionally a Google OAuth client.

```sh
git clone https://github.com/ggcaponetto/patchbay-contact-center.git
cd patchbay-contact-center
npm install
cp .env.example .env.local                 # fill in the values (see below)
lk cloud auth && lk app env -w -d .env.local   # LIVEKIT_URL / API_KEY / API_SECRET
docker compose up -d                       # Postgres on localhost:5432
```

On a headless machine (GitHub Codespaces, SSH, a container) follow
[Running in GitHub Codespaces](#running-in-github-codespaces) below instead.

Minimum `.env.local` besides the LiveKit values:

| Variable                                    | Purpose                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DATABASE_URL`                              | `postgres://cc:cc@localhost:5432/cc` (matches `docker-compose.yml`)                |
| `INTERNAL_API_SECRET`                       | shared secret between the agent worker and the API                                 |
| `ADMIN_EMAILS`                              | who becomes supervisor of a fresh tenant on first login                            |
| `BETTER_AUTH_SECRET`                        | random string (≥ 32 chars)                                                         |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth client; redirect URI `http://localhost:3000/api/auth/callback/google`        |
| `DEV_USER_EMAIL`                            | _dev only_: skip Google; the desk gets a "switch user" menu and a seeded demo team |

Start everything with one command (color-coded output via `concurrently`), or each app in its own terminal:

```sh
npm run dev          # api + web + agent + embed together

npm run dev:api      # http://localhost:4000  (set PORT / API_PORT if 4000 is taken)
npm run dev:web      # http://localhost:3000  agent & supervisor desk
npm run dev:agent    # registers the AI agent "cc-agent" with LiveKit Cloud
npm run dev:media    # media worker: music on hold
npm run dev:embed    # http://localhost:3001  demo page with the call button
```

Then: sign in on the desk → **Settings → Call button → Create key** → open
`http://localhost:3001/?key=pk_…` → press **Call us** and talk to the AI. Ask for a
person while you are **Available** on the desk and watch the ring come in. The full
walkthrough, env var reference and troubleshooting are in
[Getting started](docs/guide/getting-started.md).

### Generate the secrets

Replace every `change-me` in `.env.local` with a random value. Use a different value for
each key, e.g. `INTERNAL_API_SECRET` and `BETTER_AUTH_SECRET` (≥ 32 chars).

**Any OS (Node is already installed):**

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Linux / macOS:**

```sh
openssl rand -hex 32
```

**Windows (PowerShell):**

```powershell
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
```

Run the command once per secret and paste each result into `.env.local`. These are
server-side secrets: never commit `.env.local` or ship them to the browser.

Embed keys (`pk_…`) are **not** generated here: create them on the desk under
**Settings → Call button → Create key**. A URL like `?key=change-me` will not work.

### Running in GitHub Codespaces

A Codespace has no desktop browser and reaches your browser only through forwarded
ports, which changes three things: the LiveKit login, the sign-in (Google cannot redirect
back to a forwarded port) and the embed key's allowed origin. Step by step:

1. **Install and configure.** In the Codespace terminal:

   ```sh
   npm install
   cp .env.example .env.local
   curl -sSL https://get.livekit.io/cli | bash   # LiveKit CLI, if `lk --version` fails
   ```

2. **LiveKit credentials.** Run `lk cloud auth`. It opens a text-mode browser (lynx) in the
   terminal where sign-in does not work: quit it (`q`, then `y`), scroll up, open the
   confirmation link `lk` printed in your own browser and approve (re-run `lk cloud auth`
   for a fresh link if it exited). Then `lk app env -w -d .env.local`. Alternatively, on
   [cloud.livekit.io](https://cloud.livekit.io) open your project → **Settings → API Keys**,
   create a key and fill `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in
   `.env.local` yourself.

3. **Sign-in without Google.** In `.env.local` set `DEV_USER_EMAIL` and `ADMIN_EMAILS` to the
   same email (you become the supervisor of a fresh contact center, with a seeded demo team),
   and give `INTERNAL_API_SECRET` and `BETTER_AUTH_SECRET` random values
   (`openssl rand -hex 32`). Leave `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` empty.

4. **Postgres:** `docker compose up -d`.

5. **Start everything:** `npm run dev`. A few `[web] ws proxy error: ECONNREFUSED` lines while
   the API boots are harmless (an open desk tab reconnecting); they stop once the API logs
   `Server listening`.

6. **Open the desk.** In VS Code's **Ports** tab open port **3000** in the browser
   (`https://<codespace>-3000.app.github.dev`). Ports stay **Private**: you are signed in to
   GitHub in that browser, and the desk and the demo page both proxy `/api` to the API, so
   port 4000 is never opened. Press **Available**.

7. **Create an embed key.** **Settings → Call button → Create key**. For allowed origins enter
   **`http://localhost:3001`**, not the `app.github.dev` address: the Codespaces forwarder
   rewrites the browser's `Origin` header to `http://localhost:<port>`, so any other value
   fails with `origin_not_allowed`. Leaving the list empty (any origin) works too.

8. **Call.** Open port **3001** from the Ports tab and add the key:
   `https://<codespace>-3001.app.github.dev/?key=pk_…` (no `api` parameter; the page calls
   its own origin). Press **Call us**, allow the microphone and talk to the AI; ask for a
   person and the desk rings.

9. _Optional, for the Playwright suites:_ `sudo npx playwright install-deps chromium` once,
   since the Codespace image lacks the libraries Chromium needs.

## Using the MCP server with Claude

`apps/mcp` exposes every permission-gated API operation as an MCP tool (read
calls and transcripts, live stats, agent state, call control, queues, routing settings,
keys, team messages), so Claude can work with the contact center directly. The tools are
generated at startup from the API's `GET /api/openapi.json`.

1. **Start the API** (`npm run dev` or `npm run dev:api`).
2. **Create an API key** on the desk: **Settings → API keys**, or from Node.js with
   `node apps/mcp/scripts/create-api-key.mjs` (any OS, see [apps/mcp/README.md](apps/mcp/README.md#creating-the-key-from-node-js)).
   Its permissions bound what the tools may do; the tool list is the same for every key and calls beyond the key's
   permissions answer 403.
3. **Register the server with Claude Code**, from the repository root:

   ```sh
   claude mcp add contact-center -e MCP_API_KEY=ak_… -e MCP_API_URL=http://localhost:4000 \
     -- node "$PWD/apps/mcp/src/index.ts"
   ```

   Start it with `node`, not `npm run`: npm prints a banner on stdout, which is the
   server's protocol channel. Keep the default `local` scope (only you, only this project);
   `--scope project` would write the key into a committed `.mcp.json`.

4. **Use it:** in Claude Code, `/mcp` shows the server and its tools; then ask in plain
   words ("summarize today's calls in the support queue", "who is Ready right now?").

To list or try the tools without Claude, use the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) CLI (target first, then
`-e`, then `--method`):

```sh
npx @modelcontextprotocol/inspector --cli node "$PWD/apps/mcp/src/index.ts" \
  -e MCP_API_KEY=ak_… --method tools/list
npx @modelcontextprotocol/inspector --cli node "$PWD/apps/mcp/src/index.ts" \
  -e MCP_API_KEY=ak_… --method tools/call --tool-name get_desk_stats
```

Details: [MCP server](apps/mcp/README.md).

## Repository layout

| Path              | What                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `apps/api`        | Fastify API: Better Auth, LiveKit tokens & dispatch, routing, desk WebSocket, Drizzle/Postgres |
| `apps/agent`      | LiveKit Agents worker on LiveKit Inference; escalation & hang-up tools, transcriber            |
| `apps/media`      | Media worker: server-side audio (music on hold) over the Postgres bus                          |
| `apps/web`        | Vite + React 19 + MUI desk for agents and supervisors                                          |
| `apps/embed`      | `<cc-call-button>` web component, built to a single `call-button.js`                           |
| `apps/mcp`        | MCP server: every API operation as a tool for LLM clients, keyed by an API key                 |
| `packages/shared` | zod contracts shared by every app (settings, statuses, WebSocket protocol)                     |
| `packages/i18n`   | i18n runtime shared by the desk and the call button (languages, detection, i18next factory)    |
| `tests/`          | Playwright end-to-end (`e2e/`) and Artillery load (`load/`) suites                             |
| `docs/`           | Hand-written guides (`guide/`) and the generated API reference (`api/`)                        |
| `build/`          | Repo tooling (LOC budget gate, SAST/DAST scanners)                                             |

Plain **npm workspaces**; Node runs TypeScript directly (type stripping) so there is no build step in the dev loop.

## Scripts

| Command                    | What                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `npm run validate`         | everything CI runs: prettier, eslint, tsc, knip, cspell, LOC gate, tests, builds, docs |
| `npm test`                 | unit + integration tests with the 90 % coverage gate (integration needs Postgres)      |
| `npm run test:unit`        | unit tests only — `*.test.ts` next to the sources, no services needed                  |
| `npm run test:integration` | `*.integration.test.ts` — Postgres routes/flow, LLM-as-judge agent evals               |
| `npm run test:e2e`         | Playwright `core` tier against the real stack, AI played via the internal API          |
| `npm run test:e2e:smoke`   | the `@smoke` subset, under a minute; `test:e2e:cloud` drives the real agent (LiveKit)  |
| `npm run e2e-plan`         | checks `tests/e2e/TEST-PLAN.md` against the tagged specs (part of `validate`)          |
| `npm run test:load`        | Artillery HTTP + WebSocket profile against a running API on :4100 (opt-in)             |
| `npm run sast`             | static security scan: `npm audit` (prod deps) + Semgrep via Docker                     |
| `npm run dast`             | dynamic security scan: boots the API, OWASP ZAP baseline via Docker (needs Postgres)   |
| `npm run docs:dev`         | VitePress docs site with the typedoc API reference and mermaid diagrams                |
| `npm run build`            | production builds of the web desk and the embed script                                 |
| `npm run loc`              | size report: product code against 50k (POC target 20k), tests against their own 50k    |

## Quality gates

Every push runs `validate` on Linux, Windows and macOS: Prettier, ESLint, `tsc` per
workspace, [knip](https://knip.dev) (dead code and dependencies), cspell, the LOC gate,
the e2e test-plan gate, vitest with **90 % coverage** on logic modules, the Vite builds,
and the docs build — where typedoc **fails on any undocumented export** and VitePress
fails on dead links. Playwright runs the `smoke` and `core` end-to-end tiers on every
push and PR, and the `cloud` tier (real AI agent on LiveKit Cloud) on `main` and nightly;
one test per feature, tracked in [tests/e2e/TEST-PLAN.md](tests/e2e/TEST-PLAN.md).
Husky runs Prettier + typecheck on commit and `validate` on push. On `main`, two more
workflows run the **SAST** (`npm audit` + Semgrep) and **DAST** (OWASP ZAP baseline against
the booted API) scanners — the same `npm run sast` / `npm run dast` you can run locally with
Docker. Codecov and SonarCloud track trends (informational). Details:
[Quality gates](docs/guide/quality-gates.md).

Development follows **git flow** (`develop` integrates, `main` only receives releases and
hotfixes) and releases are tagged with **semantic versioning** (`v0.1.0`); see
[Releasing](docs/guide/releasing.md).

## Documentation

The docs are a VitePress site built from this repository — every folder's `README.md`
is a page, so architecture notes live next to the code they describe:

- **Guides:** [Getting started](docs/guide/getting-started.md), [Architecture](docs/guide/architecture.md), [Call lifecycle](docs/guide/call-lifecycle.md), [Testing](docs/guide/testing.md), [Quality gates](docs/guide/quality-gates.md), [Releasing](docs/guide/releasing.md), [Deployment](docs/guide/deployment.md), [Glossary](docs/guide/glossary.md)
- **Apps:** [API](apps/api/README.md) (+ [core modules](apps/api/src/README.md), [routes](apps/api/src/routes/README.md), [services](apps/api/src/services/README.md), [database](apps/api/src/db/README.md)), [AI agent](apps/agent/README.md), [Web desk](apps/web/README.md), [Embed button](apps/embed/README.md), [Shared contracts](packages/shared/README.md), [i18n runtime](packages/i18n/README.md), [Tests](tests/README.md)
- **API reference:** generated by typedoc from the TSDoc comments (`npm run docs:api`)

## Deployment

The `Dockerfile` builds the agent worker for [LiveKit Cloud agent deployment](https://docs.livekit.io/deploy/agents/)
(`lk agent create` / `lk agent deploy`). The API is a plain Node 24 process with Postgres
(migrations run at boot); the web desk is a static Vite build that must share an origin
with the API (or proxy `/api`) for cookies; the embed script is served by the API at
`/embed/call-button.js`. Never set `DEV_USER_EMAIL` in production. See
[Deployment](docs/guide/deployment.md).

## Project status

Working end to end against LiveKit Cloud, all five roadmap phases shipped (v0.2.0) and, in v0.3.0, configurable sounds with a desk ringtone, a rebuilt settings page, per-tab dev users and a trilingual UI (en/de/it) with the call button rebuilt in React:
embedded call → AI → escalation → human in the same room, full agent call control (hold
with music, transfers and consultations, recording via Egress, dispositions and wrap-up),
supervisor tools (whisper / barge / intercept, messaging and ticker, wallboard with
threshold alerts), skills-based routing with selection algorithms and business hours, and
an MCP server exposing every API operation as a tool. Verified by unit, integration and
Playwright e2e suites. What is deliberately later (SIP/PSTN, omnichannel, callbacks,
ring-all) is in the [Roadmap](docs/guide/roadmap.md); open items in [TODO.md](TODO.md).

## Contributing

Issues and PRs are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the
`npm run validate` gate and conventions (tests next to sources, TSDoc on every export,
a `README.md` per folder), and mind the [Code of Conduct](CODE_OF_CONDUCT.md).
Branching and versioning: [Releasing](docs/guide/releasing.md). Security issues: see
[SECURITY.md](SECURITY.md).

## License

[MIT](https://github.com/ggcaponetto/patchbay-contact-center/blob/main/LICENSE) © 2026 Giuseppe Giulio Caponetto
