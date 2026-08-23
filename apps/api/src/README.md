# Core modules (`apps/api/src`)

The files directly in `src/` are the engine of the API: boot and composition, auth,
LiveKit access, and the three modules that move a call between the AI and humans
(`routing.ts`, `flow.ts`, `ws.ts`). Routes, services and the database live in their own
folders with their own READMEs.

| File         | Role                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| `index.ts`   | Process entrypoint: loads `.env.local`, calls `start()`                           |
| `boot.ts`    | `start(env, deps)`: migrations, real dependencies, auth choice, listen            |
| `server.ts`  | `buildServer`: composition root and the `authenticate` preHandler                 |
| `auth.ts`    | Better Auth (Google) and the `DEV_USER_EMAIL` bypass                              |
| `livekit.ts` | `LiveKit` interface: tokens, agent dispatch, delete room                          |
| `routing.ts` | Postgres-backed presence and ring-offer engine (restart- and multi-instance-safe) |
| `bus.ts`     | Cross-instance message bus (`LocalBus`, `PgBus` over LISTEN/NOTIFY)               |
| `flow.ts`    | Orchestrator: escalation long-poll, human-first fallback, join/leave              |
| `ws.ts`      | `/api/ws` websocket protocol and `DeskSockets` fan-out                            |
| `testing.ts` | Test helpers (fake LiveKit, test server, fresh database)                          |

## `routing.ts`: presence and offers

`Routing` keeps its state in two Postgres tables — `agent_presence` (one row per connected
desk user, with the agent state, reason, time-in-state and the owning API instance) and
`ring_offer` (one row per call currently ringing). Nothing is in process memory, so an API
restart loses no presence or ringing call, and several API instances share one engine:
each runs the same `tick()` (heartbeat, dead-instance sweep, wrap-up and ring-timeout
expiry) and a `FOR UPDATE SKIP LOCKED` row lock decides which instance advances an offer.
It reaches desks through the {@link bus} (a desk may be on another instance) and reports
outcomes to `Flow` through `RoutingEvents`. Driven with an injected clock and a
`LocalBus` in `routing.integration.test.ts` (needs Postgres).

### Agent states and presence rules

States are the classic contact-center ones — `ready`, `not_ready` (with a reason code:
`Break`, `Lunch`, … from the tenant settings, or `RONA`), `busy` (on a call) and `acw`
(after-call work / wrap-up) — each with the time it was entered, so desks show
time-in-state timers. Logged out = no desk socket.

- `ws.ts` calls `connect` when a desk connects (a new presence starts `not_ready`; a
  second tab keeps the state) and `removePresence` when the user's last socket closes.
- State changes are REST (`POST /api/desk/state`, `/acw/extend`, `/acw/done`, and the
  supervisor's `POST /api/desk/agents/:userId/state`), handled by `setState` /
  `extendAcw`; `busy` is never requested, it is set by `accept` / `busy` (take-over).
- `setState` refuses while `busy` (`on_call`): a state change must never free an agent
  on a call. Leaving `acw` by hand ends the wrap-up.
- An agent is a **candidate** for an offer when: same tenant, state `ready`, member of
  the offer's queue, not already tried for this offer, and not currently being rung for
  another call. The first match in insertion order is taken; there is no load balancing.
- A ring that times out parks the agent: `not_ready` with reason `RONA` (redirect on no
  answer). Declines and disconnects do not.
- `release` (call ended or a desk participant left) puts whoever was on the call into
  `acw` for the tenant's `acwSec` (then `ready` automatically), or straight to `ready`
  when `acwSec` is `0`.

### Life of an offer

```mermaid
stateDiagram-v2
  [*] --> ringing: offer(callId)
  ringing --> ringing: decline, timer or disconnect, next candidate
  ringing --> accepted: accept(callId, current)
  ringing --> nobody: no candidate left, or giveUpAt reached
  ringing --> cancelled: release(callId)
  accepted --> [*]: onAccepted
  nobody --> [*]: onNobody
  cancelled --> [*]: call.offer.cancelled to current
```

Each step (`advance`) cancels the current agent (`call.offer.cancelled`), adds them to
`tried`, picks the next candidate, sends `call.offer` with an `expiresAt`, and arms a
timer. Two timings: `ringSec` (per agent, from `offerTimeoutSec` in tenant settings or
the escalation body) and the optional `giveUpAfterSec` deadline for the whole cycle used
by human-first mode; the last agent's ring is shortened so it never passes the deadline.

Presence and offers live in Postgres, so a restart keeps them; a desk that reconnects to
another instance is re-homed there (`instance_id`), and a crashed instance's users are
swept by any instance's `tick` after the 30 s heartbeat window.

## `bus.ts`: cross-instance messaging

With more than one API process, an agent's desk socket lives on one instance while the
ring that targets them may be advanced by another. Everything that must reach "whoever
holds the socket" — offers, presence snapshots, `call.updated`, transcript frames,
escalation outcomes, forced logouts — is published as a `BusMessage` and delivered to
every instance, which forwards it to the connections it holds. `PgBus` uses Postgres
`LISTEN` / `NOTIFY` (no extra infrastructure); `LocalBus` is an in-process emitter for
tests and single-process runs and is the default when `buildServer` gets no bus.

## `flow.ts`: orchestration

`Flow` owns the single `Routing` instance per process and is the only module that combines routing,
the database (`services/calls.ts`) and LiveKit. Every status write goes through its
private `status()`, which persists and emits `call.updated` on the hub.

### Escalation (AI → human)

```mermaid
sequenceDiagram
  participant AI as AI agent worker
  participant I as routes/internal
  participant F as Flow
  participant R as Routing
  participant WS as ws.ts
  participant D as Desk (agent)
  participant K as routes/desk

  AI->>I: POST /api/internal/calls/:id/escalate {reason, summary, ringSec}
  I->>F: escalate()
  F->>F: event escalation.requested, status waiting_human
  F->>R: offer({ringSec})
  R->>WS: send(userId, call.offer)
  WS-->>D: call.offer {callId, reason, summary, expiresAt}
  Note over AI,I: request stays open (long-poll)
  D->>K: POST /api/desk/calls/:id/accept
  K->>R: accept(callId, userId)
  R->>F: onAccepted
  F->>F: event offer.accepted, resolve waiter
  K->>F: join(callId, user, 'agent')
  F->>F: token, participant row, status human
  K-->>D: {token, url}
  F-->>I: {outcome: 'accepted', agentName}
  I-->>AI: 200
```

The worker's HTTP request is held open until the outcome is known, which is why the
`Waiter` map exists: `escalate` stores the promise's `resolve`, and `accepted` / `nobody`
/ `end` resolve it exactly once. If every agent declines or times out, the outcome is
`nobody`, the call goes back to `ai`, and the AI tells the caller no one is available.

### Human-first with AI fallback

```mermaid
sequenceDiagram
  participant E as Embed
  participant P as routes/public
  participant F as Flow
  participant R as Routing
  participant LK as LiveKit

  E->>P: POST /api/public/calls
  P->>P: create call, status waiting_human
  P->>F: humanFirst(callId, dispatchMetadata)
  P-->>E: {token, url} (customer joins the room and waits)
  F->>R: offer({giveUpAfterSec: humanFirstTimeoutSec, ringSec: offerTimeoutSec})
  alt someone accepts
    R->>F: onAccepted (desk accept + join set status human)
  else deadline or everyone tried
    R->>F: onNobody
    F->>LK: dispatchAgent(room, dispatchMetadata)
    F->>F: event offer.nobody, status ai
  end
```

In `ai-first` mode there is no ringing at creation: the AI is dispatched through the
customer token's room configuration and only rings humans later via `escalate`.

### Join, leave, end

- `join(callId, user, mode)`: mints a token (`agent` and `takeover` publish, `listen` is
  subscribe-only), records the participant and a `<mode>.joined` event; `agent` and
  `takeover` set the status to `human`. Returns `undefined` for ended calls.
- `leave(callId, user, role)`: stamps `leftAt`, releases the agent in routing; a `human`
  leaving ends the call.
- `end(callId)`: deletes the LiveKit room, sets `ended`, stops ringing, resolves a pending
  escalation with `nobody`. Idempotent.

## `ws.ts`: the desk websocket

### Connection lifecycle

1. Client opens `ws(s)://<api>/api/ws?tenantId=<id>` with the session cookie.
2. The server resolves the session and membership. Failure → close code `4401`.
3. The connection is added to `DeskSockets` and presence starts as `not_ready`.
4. Messages are parsed with `ClientMessage` (zod); anything else is dropped silently.
5. On close the socket is removed; presence is removed only when it was the user's last
   socket, which also moves any offer ringing them to the next agent.

Queue membership is read at connect time: after a supervisor changes queue members, the
agent must reconnect (reload the desk) to ring for the new queue.

### Client → server

| `type`          | Fields   | Effect                                               |
| --------------- | -------- | ---------------------------------------------------- |
| `subscribe`     | `callId` | Receive `transcript` messages for that call          |
| `offer.decline` | `callId` | `Routing.decline`; the offer moves to the next agent |

Accepting and every state change are **not** socket messages: `POST /api/desk/calls/:id/accept`
returns the LiveKit token, `POST /api/desk/state` and the wrap-up routes answer with the
new presence. The server → client `logout` frame tells a desk a supervisor logged it out
(the socket is then closed with `4403` and the desk does not reconnect).

### Server → client

| `type`                 | Audience              | Fields                                                         | Emitted by                                       |
| ---------------------- | --------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `presence`             | whole tenant          | `agents[]: {userId, name, status, callId}`                     | hub `presence` (Routing)                         |
| `call.offer`           | one user              | `callId, queueKey, reason?, summary?, expiresAt`               | Routing via `DeskSockets.toUser`                 |
| `call.offer.cancelled` | one user              | `callId`                                                       | Routing (timeout, decline, release)              |
| `call.updated`         | whole tenant          | `callId, status`                                               | hub `call.updated` (Flow, internal status route) |
| `transcript`           | subscribers of a call | `callId, segment: {speaker, identity, text, startMs?, endMs?}` | hub `transcript` (internal transcript route)     |

### Why early messages are buffered

`ws` delivers a message only if a `message` listener is attached at that moment. The
handler `await`s the session and membership lookups before it is ready, and a desk may
send `subscribe` right after `open`, so without a buffer the first message would be lost.
The handler therefore attaches a listener immediately that
pushes into `inbox.early` until `inbox.handle` exists, then replays the buffer in order.

## `auth.ts`

- `createAuth(db)` configures Better Auth with the Google provider and the Drizzle
  adapter over the `user` / `session` / `account` / `verification` tables. `baseURL` is
  `WEB_ORIGIN` because the web app proxies `/api` to the API, so cookies and OAuth
  redirects are all on the web origin.
- `registerAuth(app, auth)` mounts `/api/auth/*` by translating Fastify requests to Fetch
  `Request`s and copying the `Response` back, and returns a `GetSession` that validates the
  cookie on every request.
- **First-login bootstrap**: the `user.create.after` hook calls `bootstrapUser`
  (services/tenants.ts): pending invites become memberships, and `ADMIN_EMAILS` users with
  no membership get their own tenant.
- **Dev bypass** `devAuth`: with `DEV_USER_EMAIL` set (and `NODE_ENV !== 'production'`),
  the user row is created and bootstrapped once and every request, HTTP or websocket, is
  that user; `/api/auth/get-session` and `/api/auth/sign-out` are stubbed so the web
  client works unchanged. It is safe only in development because the resolver ignores
  headers entirely: whoever reaches the port is that user.

## `livekit.ts`

- `createToken` signs a 2-hour JWT with `roomJoin` on one room, the participant
  `identity` / `name`, and `attributes` (`role`, `userId`, `displayName`) that every peer
  can read to know who is who. `canPublish: false` is used for supervisors listening.
- **Dispatch via room config**: when `dispatchMetadata` is given, the token carries a
  `RoomConfiguration` with a `RoomAgentDispatch` for `cc-agent`. LiveKit starts the
  worker when the customer's connection creates the room. Used for `ai-first`.
- **Dispatch via API**: `dispatchAgent(room, metadata)` calls `AgentDispatchClient` for a
  room that already exists. Used when human-first ringing gives up.
- `deleteRoom` disconnects everyone; errors are swallowed because the room may already be
  gone.

Identities follow `<role>:<id>`: `customer:<callId>`, `ai:<callId>` (set by the worker),
`human:<userId>`, `supervisor:<userId>`.

## `server.ts`

`buildServer(deps)` registers, in order: CORS, `/api/health`, the built embed bundle at
`/embed/` (if `apps/embed/dist` exists), the auth strategy, `/api/me`, the event hub,
`DeskSockets`, `Flow`, the four route groups and the websocket. It returns `{ app, hub,
flow }` without listening. See the [API README](../README.md) for dependency injection
and the request lifecycle.

## `testing.ts`

`testServer(db, adminEmails?, resolve?)` builds a real server with `fakeLiveKit()` and a
session resolver you control (`srv.as(user).inject(...)`). `freshDb()` migrates and
truncates the test database; `dbAvailable()` lets integration suites skip when Postgres
is down. `fakeLiveKit()` records `tokens`, `dispatched` and `deleted` for assertions.

## `index.ts` and `boot.ts`

`index.ts` loads `.env.local` and calls `start()` from `boot.ts`, which runs migrations,
creates the database pool and LiveKit client, picks the auth strategy (`DEV_USER_EMAIL`
outside production, Better Auth otherwise), calls `buildServer` and listens on `PORT`.
`start(env, deps)` takes its factories as a parameter so `boot.test.ts` can run the whole
sequence with fakes.
