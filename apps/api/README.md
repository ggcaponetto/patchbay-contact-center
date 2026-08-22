# API (`apps/api`)

The API is the control plane of the contact center. It is a Fastify server that:

- creates calls for the embeddable call button and hands out LiveKit join tokens,
- keeps track of which agents are online and rings them when a call needs a human,
- receives transcripts, events and status changes from the AI agent worker,
- stores everything in Postgres (Drizzle ORM) and pushes live updates to the web desk
  over a websocket,
- authenticates desk users with Better Auth (Google) and administers tenants.

Audio never passes through the API. Customers, the AI worker and human agents all talk to
LiveKit Cloud directly; the API only decides who should be in which room and when.

## Running it

```bash
cp .env.example .env.local        # at the repo root, fill in the values below
docker compose up -d postgres     # or any Postgres reachable at DATABASE_URL
npm run dev:api                   # node --watch src/index.ts, port 4000
```

Migrations run automatically at boot. `GET /api/health` answers `{ "ok": true }`.

### Environment variables

Read from `apps/api/.env.local`, then the repo root `.env.local`.

| Variable                                    | Required | Purpose                                                                                                                                                                                                                  |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                      | no       | Listen port, default `4000`.                                                                                                                                                                                             |
| `DATABASE_URL`                              | yes      | Postgres connection string. Tests use `DATABASE_URL_TEST` when set.                                                                                                                                                      |
| `WEB_ORIGIN`                                | yes      | Origin of the web desk (`http://localhost:3000`). Better Auth base URL and trusted origin; the web app proxies `/api`.                                                                                                   |
| `API_ORIGIN`                                | no       | Not read by the API itself; the agent worker and e2e tests use it to find the API.                                                                                                                                       |
| `INTERNAL_API_SECRET`                       | yes      | Shared secret the agent worker sends as `x-internal-secret`. Boot fails when empty.                                                                                                                                      |
| `ADMIN_EMAILS`                              | no       | Comma-separated emails that may create tenants and get a personal tenant on first login.                                                                                                                                 |
| `BETTER_AUTH_SECRET`                        | yes\*    | Cookie/JWT signing secret for Better Auth.                                                                                                                                                                               |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes\*    | Google OAuth client used by Better Auth.                                                                                                                                                                                 |
| `DEV_USER_EMAIL`                            | no       | Dev only: skip Google and sign every request in as this user; a `cc_dev_user=<email>` cookie picks another (`POST /api/auth/dev-switch`, the desk's "switch user" menu, e2e actors). Ignored when `NODE_ENV=production`. |
| `DEV_DEMO_TEAM`                             | no       | With `DEV_USER_EMAIL` (default `true`): seed the demo team (`services/demo.ts`) into the dev user's tenant at boot.                                                                                                      |
| `LIVEKIT_URL`                               | yes      | `wss://...livekit.cloud`. Handed to clients with their token.                                                                                                                                                            |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`    | yes      | Sign tokens and call the room / dispatch APIs.                                                                                                                                                                           |

\* not needed when `DEV_USER_EMAIL` is set.

## Architecture

```mermaid
flowchart LR
  subgraph clients
    E[Embed button]
    D[Web desk]
    A[AI agent worker]
  end
  subgraph api [apps/api]
    P[routes/public]
    K[routes/desk + admin]
    W[ws.ts]
    I[routes/internal]
    F[flow.ts]
    R[routing.ts]
    S[services/*]
    H((event hub))
  end
  DB[(Postgres)]
  LK[LiveKit Cloud]

  E -->|POST /api/public/calls| P
  D -->|REST| K
  D <-->|/api/ws| W
  A -->|x-internal-secret| I
  P --> S
  P --> F
  K --> S
  K --> F
  I --> S
  I --> F
  F --> R
  F --> S
  S --> DB
  F -->|tokens, dispatch, delete room| LK
  I -. transcript, call.updated .-> H
  F -. presence, call.updated .-> H
  H --> W
  R -->|call.offer| W
```

Three kinds of callers, three route groups, one orchestrator:

- **Embed → `/api/public`**: unauthenticated, protected by embed key + origin allow-list.
  Creates the call and returns the customer's LiveKit token.
- **Web desk → `/api/desk`, `/api/admin`, `/api/ws`**: cookie session. REST for anything
  that returns data (accepting an offer returns a token), websocket for pushes.
- **AI agent worker → `/api/internal`**: shared secret. The worker has no database; it
  reports everything here and long-polls `escalate` when it needs a human.

`Flow` (`src/flow.ts`) is the only module that touches routing, persistence and LiveKit
together. `Routing` (`src/routing.ts`) is pure in-memory state. `services/*` are plain
database functions. The event hub is a Node `EventEmitter`: producers emit, `ws.ts`
turns events into websocket messages.

## Dependency injection

`buildServer(deps)` in `src/server.ts` is the composition root. It receives:

| Dependency                             | Production (`src/index.ts`)      | Tests (`src/testing.ts`)                             |
| -------------------------------------- | -------------------------------- | ---------------------------------------------------- |
| `db`                                   | `createDb()` from `DATABASE_URL` | `freshDb()` (migrated + truncated test database)     |
| `livekit`                              | `createLiveKit()` (real SDK)     | `fakeLiveKit()` (records calls, returns fake tokens) |
| `auth` / `devUserEmail` / `getSession` | Better Auth, or dev bypass       | `getSession` closure; `as(user)` switches the user   |
| `internalSecret`, `adminEmails`        | env vars                         | explicit values                                      |

Because nothing reads global state inside the routes, a test can build a complete server,
`inject()` HTTP requests, open real websockets with `app.listen({ port: 0 })`, and assert
on `lk.tokens` / `lk.dispatched` without mocking modules.

## Request lifecycle (authenticated routes)

1. The route's `preHandler` runs `authenticate` (defined in `buildServer`).
2. `getSession(headers)` resolves the user from the Better Auth cookie (or the dev user).
   No user → `401 { error: 'unauthenticated' }`.
3. `membershipsOf(user)` loads the tenants the user belongs to. The `x-tenant-id` header
   selects one; without it, the first membership is used.
4. `request.ctx = { user, tenantId, role }` is set. `tenantId` is `''` when the user has no
   membership.
5. Route-level hooks add checks: `member` (must have a tenant → else `403 no_tenant`),
   `supervisor` (role must be `supervisor` → else `403 forbidden`), admin
   (`ADMIN_EMAILS` → else `403 forbidden`).
6. Bodies are validated with zod through `parseBody`; failures return `400 invalid_body`.

The websocket follows the same steps on upgrade, with `?tenantId=` instead of the header.

## Module map

| Path                                 | What                                                                      | Docs                                                |
| ------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------- |
| `src/index.ts`                       | Boot: env, migrations, db, LiveKit, auth strategy, listen                 | [Core modules](./src/README.md)                     |
| `src/server.ts`                      | `buildServer`: composition root, `authenticate`, `/api/me`, `/api/health` | [Core modules](./src/README.md)                     |
| `src/auth.ts`                        | Better Auth (Google) and the `DEV_USER_EMAIL` bypass                      | [Core modules](./src/README.md)                     |
| `src/livekit.ts`                     | Tokens, agent dispatch, room deletion                                     | [Core modules](./src/README.md)                     |
| `src/routing.ts`                     | In-memory presence and ring offers                                        | [Core modules](./src/README.md)                     |
| `src/flow.ts`                        | Escalation, human-first fallback, join / leave / end                      | [Core modules](./src/README.md)                     |
| `src/ws.ts`                          | `/api/ws` desk websocket and `DeskSockets` fan-out                        | [Core modules](./src/README.md)                     |
| `src/routes/*.ts`                    | HTTP endpoints per caller                                                 | [Routes](./src/routes/README.md)                    |
| `src/services/*.ts`                  | Database operations for tenants and calls                                 | [Services](./src/services/README.md)                |
| `src/db/*.ts`, `drizzle/`            | Schema, client, migrations                                                | [Database](./src/db/README.md)                      |
| `src/testing.ts`, `*.test.ts`        | Test helpers, unit and integration suites                                 | [Core modules](./src/README.md)                     |
| `../../packages/shared/src/index.ts` | Zod contracts shared with web, embed and agent                            | [Shared contracts](../../packages/shared/README.md) |

## Tests

- Unit: `src/routing.test.ts` (fake timers, no database).
- Integration (`*.integration.test.ts`): need Postgres; they call `dbAvailable()` and
  skip themselves when it is not reachable. Run with `npm run test:integration` at the root.

## How to add an endpoint

1. Decide who calls it and pick the route file: embed → `public.ts`, agent worker →
   `internal.ts`, desk agent/supervisor → `desk.ts`, tenant admin → `admin.ts`.
2. If the request or response shape is shared with another app, add the zod schema to
   `packages/shared/src/index.ts`; otherwise define it locally in the route file.
3. Put database work in `services/tenants.ts` or `services/calls.ts` (tenant-scoped
   queries: always filter by `tenantId`). Anything touching routing or LiveKit goes
   through `Flow`.
4. In the route: pick the hook (`member`, `supervisor`, admin check, or the internal
   secret hook which is plugin-wide), validate with `parseBody`, return the data or
   `reply.code(...).send({ error })`.
5. If desks must learn about it live, emit on the `hub` and map the event in `ws.ts`
   (and extend `ServerMessage` in `@cc/shared`).
6. Write an integration test next to the route (`routes/*.integration.test.ts`) using
   `testServer` / `freshDb` from `src/testing.ts`; use `srv.as(user).inject(...)`.
7. Update the table in [routes/README.md](./src/routes/README.md) and run
   `npm run validate` (format, lint, typecheck, spell, tests).
