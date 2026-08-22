# Testing

## Taxonomy

| Kind        | Files                                       | Runner                                | Needs                                                                                           | Command                    |
| ----------- | ------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------- |
| Unit        | `*.test.ts` / `*.test.tsx` next to the code | vitest project `unit`                 | Nothing external                                                                                | `npm run test:unit`        |
| Integration | `*.integration.test.ts` next to the code    | vitest project `integration` (serial) | Postgres (API suites) and/or LiveKit Cloud credentials (agent evals); skip themselves otherwise | `npm run test:integration` |
| End-to-end  | `tests/e2e/*.spec.ts`                       | Playwright (Chromium)                 | Postgres; `LIVEKIT_*` for the handoff spec, which also starts the agent worker                  | `npm run test:e2e`         |
| Load        | `tests/load/api.yml` + `seed.mjs`           | Artillery                             | A running API on port 4100 with `DEV_USER_EMAIL` set to an admin                                | `npm run test:load`        |

`npm test` runs unit + integration with the coverage gate and is part of `npm run validate`. E2E and load are opt-in and never run in CI. `npm run test:watch` runs vitest in watch mode. See also [tests/README.md](/tests/).

## What each suite proves

**Unit** — pure logic with no I/O:

- `apps/api/src/routing.test.ts`: the ring cycle (`Routing`) with an injected clock — candidates, decline, timeouts, `giveUpAfterSec`, release.
- `apps/agent/src/api.test.ts`: `ApiClient` against a mocked `fetch` (never throws, logs failures).
- `apps/embed/src/state.test.ts`, `apps/web/src/lib/store.test.ts`: the UI reducers (`// @vitest-environment jsdom` where DOM globals are needed).

**Integration** — real Postgres through `buildServer` with the fake LiveKit:

- `apps/api/src/flow.integration.test.ts`: the whole call flow over HTTP and real websockets — create call, escalate (long-poll), ring, accept, handoff events, human-first fallback dispatch, ending.
- `apps/api/src/routes/calls.integration.test.ts`, `admin.integration.test.ts`: public/desk/internal/admin endpoints, auth and role checks.
- `apps/agent/src/agent.integration.test.ts`: the LLM evals (below). These talk to LiveKit Inference and skip without `LIVEKIT_API_KEY`.

**End-to-end** — the real browser against the real stack: `desk.spec.ts` (sign-in via dev auth, availability, dashboard, embed key creation) and `handoff.spec.ts` (customer presses the button, the AI is dispatched by LiveKit Cloud and joins, the desk sees the call, hang up).

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

**E2E** — a Playwright spec under `tests/e2e`. The config boots API, web and embed servers on 4100/3100/3101 with the dev auth user `e2e@example.com`; `globalSetup` starts the agent worker when `LIVEKIT_API_KEY` is set. Use `test.skip(!process.env.LIVEKIT_API_KEY, …)` for anything that needs the AI.

## CI behavior

`.github/workflows/ci.yml` runs a matrix on Ubuntu, Windows and macOS:

- **Linux** starts a `postgres:17-alpine` container, then runs every gate including `npm test` (with the coverage threshold and, when the repository secrets exist, the agent evals) and uploads `coverage/lcov.info` to Codecov and SonarQube.
- **Windows and macOS** have no service containers; they run `typecheck`, `npx vitest run --coverage.enabled=false` (DB suites skip themselves) and `build`. Formatting, lint, knip, cspell, LOC and docs gates run once, on Linux.

## LLM-as-judge evals

The agent tests in `apps/agent/src/agent.integration.test.ts` are behavioral evals rather than assertions on exact text. A text-only `AgentSession` runs the real agent (prompt, tools, the `google/gemma-4-31b-it` LLM through LiveKit Inference) on a user utterance; deterministic expectations check tool calls (`containsFunctionCall`, `vi.fn` arguments), and a second, separate model (`openai/gpt-4.1-mini`) is asked whether the assistant's message fulfils a stated intent. This keeps tests stable across paraphrases while still catching regressions such as the agent asking for permission before escalating. They need Cloud credentials and take up to 45 s each, so they are `describe.skipIf(!hasCloud)`.
