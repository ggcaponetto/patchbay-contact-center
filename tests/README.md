# Tests

This folder holds the suites that vitest does not run: browser end-to-end tests (Playwright) and the load test (Artillery). Unit and integration tests live next to the code they test. The full picture is in the [Testing guide](/docs/guide/testing).

## Taxonomy

| Kind        | Where                                 | Runner                       | Needs                                                                | Command                    |
| ----------- | ------------------------------------- | ---------------------------- | -------------------------------------------------------------------- | -------------------------- |
| Unit        | `apps/**/*.test.ts(x)`, `packages/**` | vitest project `unit`        | Nothing                                                              | `npm run test:unit`        |
| Integration | `apps/**/*.integration.test.ts`       | vitest project `integration` | Postgres (API), `LIVEKIT_*` (agent evals); skip themselves otherwise | `npm run test:integration` |
| End-to-end  | `tests/e2e/specs/**/*.spec.ts`        | Playwright, three tiers      | Postgres; `LIVEKIT_*` + agent worker for the `cloud` tier only       | `npm run test:e2e[:smoke   | :cloud | :all]` |
| Load        | `tests/load/api.yml`, `seed.mjs`      | Artillery                    | A running API on `:4100` with `DEV_USER_EMAIL` set to an admin email | `npm run test:load`        |

`npm test` = unit + integration with the coverage gate (part of `npm run validate`). The e2e `smoke` and `core` tiers run in CI on every push and PR, `cloud` on `main` and nightly; load is opt-in.

## Folder layout

```
tests/
  tsconfig.json          # type-checks this folder and playwright.config.ts (lib: ES2022 + DOM)
  e2e/
    TEST-PLAN.md         # one row per feature → @E2E-nn tag, tier, spec, status (gated by `npm run e2e-plan`)
    reset-db.ts          # creates/truncates the cc_e2e database before the API boots
    global-setup.ts      # starts the agent worker for the `cloud` tier, writes results/agent.log
    support/
      fixtures.ts        # `test` with supervisor / actor / queueAgent / tenant / unique / ai / call
      actors.ts          # newActor(browser, email): a context signed in as another dev user
      api.ts             # admin(), desk(), createCall(), playAi(): HTTP helpers over the API
      pages.ts           # DeskPage, DashboardPage, HistoryPage, CallPage, SettingsPage, EmbedButton
    specs/
      smoke/  embed/  desk/  supervisor/  settings/  history/  ai/   # one folder per area
    report/              # Playwright HTML report (generated, git-ignored)
    results/             # traces, agent.log (generated, git-ignored)
  load/
    api.yml              # Artillery profile: HTTP + desk websocket scenarios
    seed.mjs             # creates an embed key through the admin API, then runs Artillery
```

## Playwright (e2e)

### Tiers and tags

Each test is tagged with a **tier**, an **area** and its **plan id**, e.g. `{ tag: ['@core', '@desk', '@E2E-09'] }`. The tiers are Playwright projects in `playwright.config.ts`:

| Project | Selects                 | Needs                                | When                                                    |
| ------- | ----------------------- | ------------------------------------ | ------------------------------------------------------- |
| `smoke` | `@smoke`                | Postgres                             | `npm run test:e2e:smoke` — under a minute, first CI job |
| `core`  | everything but `@cloud` | Postgres                             | `npm run test:e2e` — every PR and push                  |
| `cloud` | `@cloud`                | `LIVEKIT_*`; starts the agent worker | `npm run test:e2e:cloud` — `main`, nightly, on demand   |

`npm run test:e2e:all` runs `core` then `cloud`; `npm run test:e2e:ui` opens the interactive runner. Filter further with `--grep @settings` or `--grep @E2E-22`. The `core` tier has no AI worker: the specs **play the AI** through `/api/internal/calls/:id/*` with the shared secret (`playAi()` in `support/api.ts` — join, speak, escalate, end), and dummy `LIVEKIT_*` values let the API mint tokens nobody connects with. What every test proves, and what is deliberately not covered, is in [TEST-PLAN.md](/tests/e2e/TEST-PLAN).

### Stack and ports

`playwright.config.ts` loads `.env.local` and boots the whole stack on ports that do not collide with your dev servers:

| Service    | Port | Started by                                                           |
| ---------- | ---- | -------------------------------------------------------------------- |
| API        | 4100 | `webServer`: `reset-db.ts` then `node src/index.ts` in `apps/api`    |
| Web desk   | 3100 | `webServer`: `npx vite` in `apps/web` (`WEB_PORT`)                   |
| Embed demo | 3101 | `webServer`: `npx vite --port 3101` in `apps/embed`                  |
| Agent      | —    | `global-setup.ts`, only for the `cloud` project with `LIVEKIT_*` set |

The API runs against **its own database** — `DATABASE_URL_E2E`, or `DATABASE_URL` with the database name replaced by `cc_e2e` — which `reset-db.ts` creates on first use and truncates before every run, so your development data is never touched. `reuseExistingServer` is `false`: stop anything already on those ports.

### Actors

The API runs with the dev-auth bypass (`DEV_USER_EMAIL=e2e@example.com`, also in `ADMIN_EMAILS`, so the default `page` is a supervisor of a bootstrapped tenant). A request can be another person by sending the `cc_dev_user=<email>` cookie (see `devAuth` in `apps/api/src/auth.ts`); the `actor(email)` fixture opens a browser context with that cookie, and `queueAgent(email)` additionally invites the person and puts them in the `support` queue so the routing rings them. Each actor has their own desk websocket, presence and ring dialog. Invite before the first request, or the person is "not a member".

### Conventions

- One `test()` per plan row; the title says what the user gets, the tags say where it runs.
- Page objects in `support/pages.ts` own locators and multi-step actions; assertions stay in the spec.
- Names that must be unique come from `unique('prefix')`; never hard-code labels that another test could create.
- The `tenant` fixture ends every live call of the tenant on teardown, so dashboards start empty.
- Chromium runs with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`: `getUserMedia` succeeds with a silent synthetic microphone, so nothing can _talk_ to the AI — escalations in the `cloud` tier are triggered through the internal API, like the worker's tool would.
- One worker, 90 s test timeout, 30 s expect timeout, one retry in CI, `trace: retain-on-failure`, HTML report in `tests/e2e/report`.

Run:

```console
npx playwright install chromium   # once
npm run test:e2e:smoke            # < 1 min
npm run test:e2e                  # core tier
npm run test:e2e:cloud            # needs LIVEKIT_* in .env.local
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
- `npx playwright test tests/e2e/specs/desk/ring.spec.ts --project core` — run one spec; `--grep @E2E-10` runs one plan row.
