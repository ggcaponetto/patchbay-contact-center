# Testing

## Taxonomy

| Kind        | Files                                       | Runner                                   | Needs                                                                                           | Command                    |
| ----------- | ------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------- |
| Unit        | `*.test.ts` / `*.test.tsx` next to the code | vitest project `unit`                    | Nothing external                                                                                | `npm run test:unit`        |
| Integration | `*.integration.test.ts` next to the code    | vitest project `integration` (serial)    | Postgres (API suites) and/or LiveKit Cloud credentials (agent evals); skip themselves otherwise | `npm run test:integration` |
| End-to-end  | `tests/e2e/specs/**/*.spec.ts`              | Playwright, tiers `smoke`/`core`/`cloud` | Postgres; `LIVEKIT_*` + the agent worker for the `cloud` tier only                              | `npm run test:e2e`         |
| Load        | `tests/load/api.yml` + `seed.mjs`           | Artillery                                | A running API on port 4100 with `DEV_USER_EMAIL` set to an admin                                | `npm run test:load`        |

`npm test` runs unit + integration with the coverage gate and is part of `npm run validate`. The e2e `smoke` and `core` tiers run in CI on every push and pull request, the `cloud` tier on `main` and nightly; load is opt-in. `npm run test:watch` runs vitest in watch mode. See also [tests/README.md](/tests/) and the [e2e test plan](/tests/e2e/TEST-PLAN).

## What each suite proves

**Unit** — pure logic with no I/O:

- `apps/api/src/routing.test.ts`: the ring cycle (`Routing`) with an injected clock — candidates, decline, timeouts, `giveUpAfterSec`, release.
- `apps/agent/src/api.test.ts`: `ApiClient` against a mocked `fetch` (never throws, logs failures).
- `apps/embed/src/state.test.ts`, `apps/web/src/lib/store.test.ts`: the UI reducers (`// @vitest-environment jsdom` where DOM globals are needed).

**Integration** — real Postgres through `buildServer` with the fake LiveKit:

- `apps/api/src/flow.integration.test.ts`: the whole call flow over HTTP and real websockets — create call, escalate (long-poll), ring, accept, handoff events, human-first fallback dispatch, ending.
- `apps/api/src/routes/calls.integration.test.ts`, `admin.integration.test.ts`: public/desk/internal/admin endpoints, auth and role checks.
- `apps/agent/src/agent.integration.test.ts`: the LLM evals (below). These talk to LiveKit Inference and skip without `LIVEKIT_API_KEY`.

**End-to-end** — the real browser against the real stack, one test per feature of the [test plan](/tests/e2e/TEST-PLAN): the embedded button and its error states, presence and the ring cycle (accept, decline, timeout, queue membership) with several signed-in actors, the in-call panel and hang-up, live transcript and call detail, history, supervisor listen-in / take-over and role gates, every settings card (routing, team invites, queues, embed keys), multi-tenancy — all without LiveKit Cloud (`core` tier, the AI is played through the internal API) — plus the `cloud` tier: the real agent answering, both handoff modes, human-first fallback and the customer hanging up.

**Load** — `api.yml` ramps 2 → 20 arrivals/s for 30 s then sustains 20/s for 30 s across three scenarios (create call, desk reads, websocket presence) and fails when p95 latency exceeds 300 ms or the error rate 1%.

## Coverage gate

`vitest.config.ts` enforces 90% lines, functions, branches and statements (v8 provider) across **every source file** in `apps/*/src` and `packages/*/src`; only the test files themselves are excluded. The thresholds are global, so a handful of tiny lines in an entrypoint do not fail the build, but every module is expected to carry its own tests:

- pure logic (routing, reducers, state machines, services) is tested directly;
- wiring (Fastify composition, LiveKit clients, React components, the web component, the agent worker) is tested with fakes at the module boundary — `vi.mock('livekit-client')`, a fake `WebSocket`, a fake job context, `fakeLiveKit()` from `apps/api/src/testing.ts`;
- process entrypoints (`apps/api/src/index.ts`, `apps/agent/src/main.ts`, `apps/web/src/main.tsx`) stay a few lines long and delegate to a testable module.

Do not widen `exclude` to get past a failure; add a test or split the module so its logic becomes testable.

## How to write each kind

**Unit** — import the module, no setup:

```ts
import { describe, expect, it } from 'vitest';
import { reduce } from './state.ts';

it('a human replaces the AI label', () => {
  const inCall = reduce(
    { kind: 'waiting', since: 0 },
    { type: 'peer_joined', role: 'ai', name: undefined },
  );
  const next = reduce(inCall, { type: 'peer_joined', role: 'human', name: 'Ada' });
  expect(next).toMatchObject({ kind: 'in_call', with: 'Agent Ada' });
});
```

**Integration (API)** — use the helpers in `apps/api/src/testing.ts`. `dbAvailable()` decides whether the file skips, `freshDb()` migrates and truncates, `testServer(db, adminEmails?)` builds the app with `fakeLiveKit()` and returns `as(user)` to switch the signed-in user per request plus `lk` (recorded tokens / dispatches / deletions), `resetDb()` runs in `beforeEach`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, dbAvailable, freshDb, resetDb, testServer } from './testing.ts';

const hasDb = await dbAvailable();

describe.skipIf(!hasDb)('admin routes', () => {
  let ctx: Awaited<ReturnType<typeof freshDb>>;
  beforeAll(async () => (ctx = await freshDb()));
  afterAll(() => ctx.close());
  beforeEach(() => resetDb(ctx.db));

  it('rejects non-supervisors', async () => {
    const { as } = await testServer(ctx.db);
    const agent = await createUser(ctx.db, 'agent@example.com');
    const res = await as(agent).inject({ method: 'GET', url: '/api/admin/tenant' });
    expect(res.statusCode).toBe(403);
  });
});
```

Name the file `*.integration.test.ts`; integration files run serially because they share one database.

**Agent eval** — build the agent with fake actions, drive an `AgentSession` without audio, and judge the reply with an LLM:

```ts
const actions = {
  escalate: vi.fn(async () => 'Tell the caller you are connecting them.'),
  endCall: vi.fn(),
};
const session = new voice.AgentSession();
await session.start({
  agent: createAgent({ instructions: 'The company is Acme Bikes.', actions }),
});

const result = await session.run({ userInput: 'I want a real person.' }).wait();
result.expect.containsFunctionCall({ name: 'escalateToHuman' });
await result.expect
  .containsMessage({ role: 'assistant' })
  .judge(judgeLlm, { intent: 'Tells the caller they are being connected to a human.' });
```

Follow TDD for prompt and tool changes (see `AGENTS.md`): write the eval first, then iterate on instructions until it passes.

**E2E** — a Playwright spec under `tests/e2e/specs/<area>/`, importing `test` from `../../support/fixtures.ts`. Every test is tagged with its tier, area and plan id, and the plan row must exist (`npm run e2e-plan`):

```ts
import { DeskPage, desk, expect, test } from '../../support/fixtures.ts';

test(
  'a declined offer moves on to the next available agent',
  { tag: ['@core', '@desk', '@E2E-10'] },
  async ({ queueAgent, unique, tenant, call, ai }) => {
    const first = await queueAgent(`${unique('first')}@example.com`); // invited, signed in, in the queue
    const second = await queueAgent(`${unique('second')}@example.com`);
    for (const a of [first, second]) {
      const d = new DeskPage(a.page);
      await d.goto();
      await d.setAvailable();
    }
    const { callId } = await call(tenant.key); // what the embedded button does
    const agent = ai(callId); // the AI worker, played over /api/internal
    await agent.join();
    const outcome = agent.escalate(); // long-poll, resolved by the desk
    await new DeskPage(first.page).expectRinging();
    await new DeskPage(first.page).decline();
    await new DeskPage(second.page).expectRinging();
    await new DeskPage(second.page).accept();
    expect(await outcome).toEqual({ outcome: 'accepted', agentName: second.name });
  },
);
```

The config boots API (against the `cc_e2e` database), web and embed servers on 4100/3100/3101 with the dev auth user `e2e@example.com` as supervisor; other people are browser contexts carrying the `cc_dev_user` cookie (`actor(email)`). `global-setup.ts` starts the agent worker only for the `cloud` project; `cloud` specs also guard with `test.skip(!HAS_CLOUD, …)`. Tiers, fixtures, page objects and conventions: [tests/README.md](/tests/).

## CI behavior

`.github/workflows/ci.yml` runs a matrix on Ubuntu, Windows and macOS:

- **Linux** starts a `postgres:17-alpine` container, then runs every gate including `npm test` (with the coverage threshold and, when the repository secrets exist, the agent evals) and uploads `coverage/lcov.info` to Codecov and SonarQube.
- **Windows and macOS** have no service containers; they run `typecheck`, `npx vitest run --coverage.enabled=false` (DB suites skip themselves) and `build`. Formatting, lint, knip, cspell, LOC and docs gates run once, on Linux.
- `e2e-smoke` then `e2e-core` run the Playwright tiers on every push and PR (Postgres only); `e2e-cloud` runs on `main` when the `LIVEKIT_*` secrets exist, and the `E2E` workflow repeats `core` + `cloud` nightly.

## LLM-as-judge evals

The agent tests in `apps/agent/src/agent.integration.test.ts` are behavioral evals rather than assertions on exact text. A text-only `AgentSession` runs the real agent (prompt, tools, the `google/gemma-4-31b-it` LLM through LiveKit Inference) on a user utterance; deterministic expectations check tool calls (`containsFunctionCall`, `vi.fn` arguments), and a second, separate model (`openai/gpt-4.1-mini`) is asked whether the assistant's message fulfils a stated intent. This keeps tests stable across paraphrases while still catching regressions such as the agent asking for permission before escalating. They need Cloud credentials and take up to 45 s each, so they are `describe.skipIf(!hasCloud)`.
