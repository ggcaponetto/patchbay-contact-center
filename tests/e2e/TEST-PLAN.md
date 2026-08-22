# End-to-end test plan

The source of truth for **feature coverage**: one row per meaningful user-facing behavior, linked to the Playwright test that proves it by its `@E2E-nn` tag. `npm run e2e:plan` (part of `validate`) fails when this table and the specs under `tests/e2e/specs` drift apart. How to keep it current is in [AGENTS.md](/AGENTS) ("End-to-end test plan"); how the suite is organized (tiers, tags, fixtures, actors) is in [tests/README.md](/tests/) and the [Testing guide](/docs/guide/testing).

## Tiers

| Tier  | Tag      | Needs                                          | Budget  | Runs                                                           |
| ----- | -------- | ---------------------------------------------- | ------- | -------------------------------------------------------------- |
| smoke | `@smoke` | Postgres (dummy LiveKit credentials suffice)   | < 1 min | `npm run test:e2e:smoke`; first CI job on every push and PR    |
| core  | `@core`  | Postgres; the AI is played via `/api/internal` | ~2 min  | `npm run test:e2e`; every PR and push to `develop` / `main`    |
| cloud | `@cloud` | `LIVEKIT_*` + the agent worker (global setup)  | ~2 min  | `npm run test:e2e:cloud`; pushes to `main`, nightly, on demand |

`@smoke` tests are part of the core tier too (`core` = everything that is not `@cloud`). Every test carries exactly one tier tag, at least one area tag (`@embed`, `@desk`, `@supervisor`, `@settings`, `@history`, `@ai`) and its plan id.

## Coverage

Status: **implemented** (a tagged test exists), **planned** (write it next), **blocked** (needs a product or tooling change first — say which).

| Id     | Feature                                                                                                             | Area       | Tier  | Spec                                 | Status                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------- | ---------- | ----- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| E2E-01 | Stack boots: `/api/health`, the desk signs the dev user in, the embed page renders the button                       | desk/embed | smoke | `smoke/boot.spec.ts`                 | implemented                                                                               |
| E2E-02 | Available/Away toggle is reflected on the dashboard                                                                 | desk       | smoke | `desk/availability.spec.ts`          | implemented                                                                               |
| E2E-03 | Create an embed key; the snippet carries the key and the script tag                                                 | settings   | smoke | `settings/embed-keys.spec.ts`        | implemented                                                                               |
| E2E-04 | Embed: missing `key` → inline error, no request made                                                                | embed      | core  | `embed/call-button-errors.spec.ts`   | implemented                                                                               |
| E2E-05 | Embed: unknown key → `unknown_embed_key_or_queue`; the next click retries                                           | embed      | core  | `embed/call-button-errors.spec.ts`   | implemented                                                                               |
| E2E-06 | Embed: key restricted to another origin → `origin_not_allowed`; the allowed origin passes                           | embed      | core  | `embed/call-button-errors.spec.ts`   | implemented                                                                               |
| E2E-07 | A new call shows live on the dashboard as "With AI" with page and duration; click opens the call page               | supervisor | core  | `supervisor/dashboard.spec.ts`       | implemented                                                                               |
| E2E-08 | Escalation rings the available queue member with reason, summary and countdown                                      | desk       | core  | `desk/ring.spec.ts`                  | implemented                                                                               |
| E2E-09 | Accept: call goes to the agent, events/participants recorded, agent shown as on a call                              | desk       | core  | `desk/ring.spec.ts`                  | implemented                                                                               |
| E2E-10 | Decline: the next available agent is rung (two agents)                                                              | desk       | core  | `desk/ring.spec.ts`                  | implemented                                                                               |
| E2E-11 | Ring timeout: escalation resolves `nobody`, dialog closes, call back with the AI                                    | desk       | core  | `desk/ring.spec.ts`                  | implemented                                                                               |
| E2E-12 | Away agents and non-members of the queue are never rung                                                             | desk       | core  | `desk/ring.spec.ts`                  | implemented                                                                               |
| E2E-13 | Hang up from the desk: live transcript while on the call, call ended, agent back to Available, history shows Ended  | desk       | core  | `desk/in-call.spec.ts`               | implemented                                                                               |
| E2E-14 | Live transcript on the call page, in order, also when the page is opened mid-call                                   | history    | core  | `history/call-detail.spec.ts`        | implemented                                                                               |
| E2E-15 | Call page: status chip, queue, events timeline, AI summary after the call ends                                      | history    | core  | `history/call-detail.spec.ts`        | implemented                                                                               |
| E2E-16 | History table: newest first, queue, status, duration, summary; live refresh; row opens the call page                | history    | core  | `history/history.spec.ts`            | implemented                                                                               |
| E2E-17 | Listen in: silent, status unchanged, `listen.joined` / `supervisor.left`, the call goes on                          | supervisor | core  | `supervisor/listen-takeover.spec.ts` | implemented                                                                               |
| E2E-18 | Take over: status "With agent", `takeover.joined`; hanging up ends the call                                         | supervisor | core  | `supervisor/listen-takeover.spec.ts` | implemented                                                                               |
| E2E-19 | Agent role: no Dashboard/Settings tabs, `POST /join` → 403                                                          | supervisor | core  | `supervisor/dashboard.spec.ts`       | implemented                                                                               |
| E2E-20 | Routing settings: save, survive reload, reject out-of-range values                                                  | settings   | core  | `settings/routing.spec.ts`           | implemented                                                                               |
| E2E-21 | Team: invite an agent → pending; first sign-in makes them a member with the agent's view                            | settings   | core  | `settings/team.spec.ts`              | implemented                                                                               |
| E2E-22 | Queues: new queue gets a slug key, members toggled, a call on that queue rings only its members                     | settings   | core  | `settings/queues.spec.ts`            | implemented                                                                               |
| E2E-23 | Embed keys: allowed origins shown, delete removes the key, calls with it fail                                       | settings   | core  | `settings/embed-keys.spec.ts`        | implemented                                                                               |
| E2E-24 | Multi-tenant: a member of two contact centers gets the selector; switching re-scopes history                        | supervisor | core  | `supervisor/tenants.spec.ts`         | implemented                                                                               |
| E2E-25 | Presence follows the socket: closing the desk removes the agent from Agents online                                  | desk       | core  | `desk/availability.spec.ts`          | implemented                                                                               |
| E2E-26 | Real call: Call us → the AI joins ("AI assistant"), its greeting arrives in the transcript                          | ai         | cloud | `ai/ai-first.spec.ts`                | implemented                                                                               |
| E2E-27 | Real handoff `leave`: accept from the desk, button shows "Agent", `handoff {leave}`, the AI becomes the transcriber | ai         | cloud | `ai/handoff-modes.spec.ts`           | implemented                                                                               |
| E2E-28 | Real handoff `listen`: `handoff {listen}`, the AI stays in the room muted                                           | ai         | cloud | `ai/handoff-modes.spec.ts`           | implemented                                                                               |
| E2E-29 | Human-first: humans are rung first, nobody → the AI is dispatched as fallback                                       | ai         | cloud | `ai/human-first.spec.ts`             | implemented                                                                               |
| E2E-30 | Customer hangs up: the AI leaves, the call is ended in history                                                      | ai         | cloud | `ai/ai-first.spec.ts`                | implemented                                                                               |
| E2E-31 | The AI ends the call itself (`endCall` tool → `call.ended_by_ai`) after the caller says goodbye                     | ai         | cloud | `ai/ai-first.spec.ts`                | blocked: the fake microphone cannot speak; needs synthetic speech injection into the room |
| E2E-33 | Dev login: the app bar "Signed in as …" menu switches the desk to another person (dev bypass only)                  | desk       | core  | `desk/dev-login.spec.ts`             | implemented                                                                               |
| E2E-32 | Google sign-in and sign-out on the desk                                                                             | desk       | cloud | —                                    | blocked: no Google OAuth client configured (TODO.md); dev auth is used instead            |

## Not covered on purpose

- Creating a tenant from the desk — API only (`POST /api/admin/tenants`), no UI yet.
- Removing a member or changing a role — not implemented (invite-only, one-way).
- Handing a call back to the AI after a `listen` handoff — not implemented (TODO.md).
- Human-first call where the customer hangs up while still ringing — known bug (TODO.md), the call stays `waiting_human`.
- The AI summary covering the human part of the call — known limitation (TODO.md); E2E-15 asserts the summary the worker posts.
- Throughput and latency — the Artillery profile in `tests/load` (see [tests/README.md](/tests/)).
