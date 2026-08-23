# Architecture

## Workspaces

The repo is an npm-workspaces monorepo (`packages/*`, `apps/*`). Node 24 runs the TypeScript sources directly with type stripping, so there is no build step for the API and the agent; imports use explicit `.ts` extensions and `tsc` only type-checks.

| Path              | Package      | What it is                                                                                                                                                                                                 |
| ----------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | `@cc/shared` | zod schemas and inferred types shared by every app: `TenantSettings`, `CallStatus`, `ParticipantKind`, `DispatchMetadata`, websocket `ServerMessage` / `ClientMessage`, `roomNameFor`.                     |
| `packages/i18n`   | `@cc/i18n`   | The i18n runtime of the two UIs: supported languages (en, de, it), BCP 47 normalization, the desk's `cc_lng` cookie and the i18next instance factory; translations live next to each app in `src/locales`. |
| `apps/api`        | `@cc/api`    | Fastify 5 API: Better Auth (Google), Drizzle + Postgres, LiveKit tokens and agent dispatch, Postgres-backed routing, `/api/ws` desk websocket, serves the built embed script.                              |
| `apps/agent`      | `@cc/agent`  | LiveKit Agents worker registered as `cc-agent`. Voice pipeline on LiveKit Inference, `escalateToHuman` / `endCall` tools, post-handoff transcriber, LLM summary.                                           |
| `apps/web`        | `@cc/web`    | Vite + React 19 + MUI desk for agents and supervisors (Desk, Dashboard, History, Settings, call page). Hash routing, TanStack Query, one websocket per tenant.                                             |
| `apps/embed`      | `@cc/embed`  | `<cc-call-button>` web component built as a single IIFE `call-button.js`. Pure state reducer in `state.ts`, LiveKit client in `call-button.ts`.                                                            |

Supporting folders: `tests/` (Playwright e2e, Artillery load), `build/` (the LOC gate), `docs/` (this site plus the generated API reference), `apps/api/drizzle` (SQL migrations).

## System diagram

```mermaid
flowchart TB
  subgraph browsers[Browsers]
    btn["Customer: cc-call-button"]
    web["Agent / supervisor: web desk"]
  end
  subgraph apiBox[apps/api — one Node process]
    routes["Routes<br/>/api/public · /api/desk · /api/admin · /api/internal"]
    flow["Flow + Routing<br/>(presence & offers in Postgres)"]
    hub["EventEmitter hub"]
    ws["/api/ws DeskSockets"]
    routes --> flow
    routes --> hub
    flow --> hub
    hub --> ws
    flow -- "ring offers" --> ws
  end
  pg[(Postgres<br/>tenant · membership · queue · embed_key<br/>call · call_participant · transcript_segment · call_event)]
  subgraph cloud[LiveKit Cloud]
    room["Room cc-&lt;tenant&gt;-&lt;call&gt;"]
    dispatch["Agent dispatch (cc-agent)"]
    inf["LiveKit Inference"]
  end
  worker["apps/agent worker"]

  btn -- "POST /api/public/calls" --> routes
  btn <-- "WebRTC" --> room
  web -- "REST (cookie session)" --> routes
  web <-- "websocket" --> ws
  web <-- "WebRTC" --> room
  routes -- "Drizzle" --> pg
  routes -- "token with RoomConfiguration / createDispatch / deleteRoom" --> cloud
  dispatch -- "job metadata = DispatchMetadata" --> worker
  worker <-- "WebRTC" --> room
  worker -- "STT / LLM / TTS" --> inf
  worker -- "POST /api/internal/calls/:id/* (x-internal-secret)" --> routes
```

## End-to-end: `ai-first` call with escalation

Default tenant mode. The AI answers immediately; a human is rung only when the LLM calls `escalateToHuman`.

```mermaid
sequenceDiagram
  autonumber
  participant C as Customer (cc-call-button)
  participant API as API (Fastify)
  participant DB as Postgres
  participant LK as LiveKit Cloud
  participant AG as Agent worker (cc-agent)
  participant D as Desk (agent browser)

  C->>API: POST /api/public/calls {embedKey, queue, customerMeta}
  API->>DB: call (status ringing) + participant customer:callId + event call.created
  API->>API: token for customer:callId with RoomAgentDispatch(cc-agent, DispatchMetadata)
  API->>DB: status = ai
  API-->>C: {callId, roomName, token, url}
  C->>LK: connect(url, token), publish microphone
  LK->>AG: job for room, metadata = DispatchMetadata
  AG->>LK: join as ai:callId, attributes {role: ai}
  AG->>API: POST participants {ai} · POST events ai.joined
  AG->>C: greeting (generateReply with tenant greeting)
  loop every committed user / assistant message
    AG->>API: POST transcript {speaker customer|ai}
    API-->>D: ws transcript (to subscribers of the call)
  end
  C->>AG: "I want to talk to a real person"
  AG->>AG: LLM calls escalateToHuman(reason, summary)
  AG->>C: say "One moment please, I am connecting you…"
  AG->>API: POST escalate {reason, summary, ringSec} (long-poll)
  API->>DB: event escalation.requested · status waiting_human
  API-->>D: ws call.offer {callId, queueKey, reason, summary, expiresAt}
  D->>API: POST /api/desk/calls/:id/accept
  API->>DB: event offer.accepted · participant human:userId · event agent.joined · status human
  API-->>D: {token, url}
  API-->>AG: escalate resolves {outcome: accepted, agentName}
  AG->>C: "(agent name) is joining the call now."
  D->>LK: join the same room as human:userId
  LK->>AG: ParticipantConnected (role human)
  AG->>API: POST events handoff {to, behavior}
  alt aiBehavior = leave (default)
    AG->>AG: session.close(), attributes {role: transcriber}
    AG->>API: participants ai left · participants transcriber joined
  else aiBehavior = listen
    AG->>AG: interrupt, audio output disabled, keep listening
  end
  loop transcriber
    AG->>API: POST transcript {speaker human|customer}
  end
  D->>API: POST /api/desk/calls/:id/leave {role human}
  API->>DB: event human.left · status ended
  API->>LK: deleteRoom
  LK->>AG: customer disconnected → ctx.shutdown()
  AG->>AG: summarize(session.history)
  AG->>API: POST participants left · POST status {ended, summary}
  API-->>D: ws call.updated {ended}
```

Notes:

- Step 3 is why the AI joins without an explicit dispatch call: the customer's token carries a `RoomConfiguration` with a `RoomAgentDispatch`, so LiveKit Cloud dispatches `cc-agent` when the room is created.
- `escalate` is a long-poll: the HTTP request stays open until a human accepted or nobody could, so the LLM tool returns the real outcome as the next sentence to say.
- The customer hanging up first ends with the same tail: the agent sees `ParticipantDisconnected` for `customer:callId`, shuts down and posts `status ended`, and `Flow.end` deletes the room.

## End-to-end: `human-first` call

Humans are rung first; the AI is a fallback.

```mermaid
sequenceDiagram
  autonumber
  participant C as Customer
  participant API as API
  participant D as Desk
  participant LK as LiveKit Cloud
  participant AG as Agent worker

  C->>API: POST /api/public/calls
  API->>API: token WITHOUT agent dispatch · status waiting_human
  API->>API: Flow.humanFirst: Routing.offer(giveUpAfterSec = humanFirstTimeoutSec, ringSec = offerTimeoutSec)
  API-->>C: {token, url}
  C->>LK: join room (hears nothing yet, button shows "Please hold")
  API-->>D: ws call.offer (agent 1)
  D-->>API: ws offer.decline / timeout
  API-->>D: ws call.offer (agent 2) …
  alt someone accepts within humanFirstTimeoutSec
    D->>API: POST accept
    API->>API: events offer.accepted, agent.joined · status human
    D->>LK: join room as human:userId
  else deadline reached or queue exhausted
    API->>API: event offer.nobody
    API->>LK: AgentDispatchClient.createDispatch(room, cc-agent, metadata)
    API->>API: status ai
    LK->>AG: job → AI greets and continues as in ai-first
  end
```

## Key design decisions

**Same-room handoff.** The human agent joins the room the customer is already in; nobody is transferred, re-dialed or re-tokened. The customer's button just swaps its label from "AI assistant" to "Agent Name". This also lets the AI participant stay in the room after handoff as a transcriber (see below) and lets supervisors listen in or take over the very same room.

**Long-poll escalation.** `POST /api/internal/calls/:id/escalate` does not return until `Flow` resolves the waiter (`accepted` with the agent's name, or `nobody`). The agent's `escalateToHuman` tool therefore gets a concrete sentence to say back. The cost is an open HTTP request for up to the whole ring cycle, acceptable for the POC.

**Postgres-backed routing.** `Routing` (`apps/api/src/routing.ts`) keeps presence (`agent_presence`) and ringing offers (`ring_offer`) in Postgres, so a restart loses neither and several API instances share one engine: each runs the same periodic `tick()` and a `FOR UPDATE SKIP LOCKED` lock decides who advances an offer. Cross-instance delivery (an offer must reach a desk that may be on another instance) goes over a message bus (`bus.ts`): Postgres `LISTEN`/`NOTIFY` in production, an in-process emitter in tests. No Redis.

**zod contracts in `packages/shared`.** Tenant settings, call status, participant attributes, dispatch metadata and both websocket message unions are zod schemas; every boundary (`parseBody`, `ClientMessage.safeParse`, `DispatchMetadata.parse`) validates at runtime and the types are inferred once. The same file also owns `roomNameFor`.

**Dependency injection and fakes in tests.** `buildServer` takes `db`, `livekit`, and either a real `auth`, a `devUserEmail` or a `getSession` function. `LiveKit` is a four-method interface, so `apps/api/src/testing.ts` provides `fakeLiveKit()` that records tokens, dispatches and deletions. The agent's tools take an `AgentActions` object so evals can assert on `escalate` / `endCall` with `vi.fn()`.

**Dev auth bypass.** `DEV_USER_EMAIL` replaces Better Auth with a resolver that signs every request in as one user and answers the web client's `get-session` probe locally. `apps/api/src/index.ts` ignores it when `NODE_ENV=production`. Playwright and the load test rely on it.

**npm workspaces + type stripping.** No bundler for server code; `node src/index.ts` runs as-is. `tsconfig.base.json` sets `erasableSyntaxOnly` so enums, namespaces and parameter properties cannot sneak in.

**LOC budget.** `build/loc.mjs` fails `validate` above 50k non-blank tracked source lines and warns above 20k. The repo is meant to stay small enough for one person to hold in their head; see [Build scripts](/build/).
