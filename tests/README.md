# Tests

This folder holds the suites that vitest does not run: browser end-to-end tests (Playwright) and the load test (Artillery). Unit and integration tests live next to the code they test. The full picture is in the [Testing guide](/docs/guide/testing).

## Taxonomy

| Kind        | Where                                 | Runner                       | Needs                                                                | Command                    |
| ----------- | ------------------------------------- | ---------------------------- | -------------------------------------------------------------------- | -------------------------- |
| Unit        | `apps/**/*.test.ts(x)`, `packages/**` | vitest project `unit`        | Nothing                                                              | `npm run test:unit`        |
| Integration | `apps/**/*.integration.test.ts`       | vitest project `integration` | Postgres (API), `LIVEKIT_*` (agent evals); skip themselves otherwise | `npm run test:integration` |
| End-to-end  | `tests/e2e/*.spec.ts`                 | Playwright                   | Postgres; `LIVEKIT_*` + agent worker for `handoff.spec.ts`           | `npm run test:e2e`         |
| Load        | `tests/load/api.yml`, `seed.mjs`      | Artillery                    | A running API on `:4100` with `DEV_USER_EMAIL` set to an admin email | `npm run test:load`        |

`npm test` = unit + integration with the coverage gate (part of `npm run validate`). E2E and load are opt-in and not part of `validate` or CI.

## Folder layout

```
tests/
  tsconfig.json        # type-checks this folder and playwright.config.ts (lib: ES2022 + DOM)
  e2e/
    global-setup.ts    # starts the agent worker, writes results/agent.log
    desk.spec.ts       # sign-in, availability, dashboard, embed key (no Cloud needed)
    handoff.spec.ts    # customer → AI through the real button (needs LIVEKIT_*)
    report/            # Playwright HTML report (generated, git-ignored)
    results/           # traces, agent.log (generated, git-ignored)
  load/
    api.yml            # Artillery profile: HTTP + desk websocket scenarios
    seed.mjs           # creates an embed key through the admin API, then runs Artillery
```

## Playwright (e2e)

`playwright.config.ts` at the repo root loads `.env.local` and boots the whole stack itself on ports that do not collide with your dev servers:

| Service    | Port | Started by                                             |
| ---------- | ---- | ------------------------------------------------------ |
| API        | 4100 | `webServer`: `node src/index.ts` in `apps/api`         |
| Web desk   | 3100 | `webServer`: `npx vite` in `apps/web` (`WEB_PORT`)     |
| Embed demo | 3101 | `webServer`: `npx vite --port 3101` in `apps/embed`    |
| Agent      | —    | `global-setup.ts` (only when `LIVEKIT_API_KEY` is set) |

The servers receive `DEV_USER_EMAIL=e2e@example.com` and `ADMIN_EMAILS=e2e@example.com`, so the browser is signed in as a supervisor of a bootstrapped tenant without Google, plus `API_ORIGIN`/`WEB_ORIGIN` for the test ports and `INTERNAL_API_SECRET` (`e2e-secret` unless set). `reuseExistingServer` is `false`: stop anything already on those ports. The tests use the same Postgres as development (`DATABASE_URL`), so expect test tenants and calls to appear in your local database.

`global-setup.ts` spawns `node src/main.ts dev` in `apps/agent` without a shell, waits up to 60 s for the `registered worker` log line and pipes all worker output to `tests/e2e/results/agent.log`. Its teardown kills the whole process tree (`taskkill /t` on Windows), because a stale worker would steal the next dispatch.

Chromium runs with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, so `getUserMedia` succeeds with a synthetic microphone and no permission prompt. Other settings: one worker, no retries, 90 s test timeout, 30 s expect timeout, `trace: retain-on-failure`, HTML report in `tests/e2e/report`.

Run:

```console
npx playwright install chromium   # once
npm run test:e2e
```

## Artillery (load)

`npm run test:load` runs `tests/load/seed.mjs`, which:

1. `POST`s `/api/admin/embed-keys` on `LOAD_API` (default `http://localhost:4100`) — this only works when the API runs with `DEV_USER_EMAIL` set to an email in `ADMIN_EMAILS`, so the dev user is a supervisor;
2. exports the returned key as `LOAD_EMBED_KEY` and runs `npx artillery run tests/load/api.yml`.

Start the API first, for example `PORT=4100 DEV_USER_EMAIL=<admin email> npm run dev:api` (with the matching `ADMIN_EMAILS`). The profile ramps from 2 to 20 arrivals/s over 30 s, then holds 20/s for 30 s, weighting three scenarios: customer starts a call (5), desk reads `/api/me` and `/api/desk/calls` (3), desk presence over the websocket (2). Thresholds: p95 response time under 300 ms and error rate under 1%, otherwise Artillery exits non-zero. Each "start a call" scenario creates a real call row and mints a real LiveKit token, so use a throwaway tenant. Not run in CI.

## Debugging

- `npx playwright show-report tests/e2e/report` — open the last HTML report.
- `npx playwright show-trace tests/e2e/results/<test-folder>/trace.zip` — step through a failed test with DOM snapshots and network.
- `npx playwright test --headed` or `--ui` — watch the browser / use the interactive runner. `--debug` adds the inspector.
- `tests/e2e/results/agent.log` — what the agent worker printed; look here when the AI never joins.
- `npx playwright test tests/e2e/desk.spec.ts` — run one spec; add `-g "embed key"` to filter by title.
