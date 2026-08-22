# Contributing

Thanks for helping out. This page is the short version; the
[developer documentation](https://ggcaponetto.github.io/livekit-playground/) has the details.

## Setup

Follow [Getting started](docs/guide/getting-started.md): Node ≥ 24, `npm install`,
Postgres via `docker compose up -d`, a LiveKit Cloud project, and `.env.local`.
`DEV_USER_EMAIL` lets you skip Google OAuth while developing.

## Before you open a pull request

```sh
npm run validate
```

It runs exactly what CI runs: Prettier, ESLint, `tsc`, knip, cspell, the LOC gate,
unit + integration tests with the 90 % coverage threshold, the builds and the docs build.
Husky runs the formatter and typecheck on commit and `validate` on push, so a green push
is usually a green PR. Typical fixes:

| Failure                          | Fix                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| knip: unused dependency / export | remove it, or use it — don't add dependencies before they are imported              |
| cspell: unknown word             | add real words to `cspell.json` (`words`, sorted); fix typos                        |
| coverage below 90 %              | add a unit test for the logic module; pure wiring is excluded in `vitest.config.ts` |
| typedoc: export not documented   | add a TSDoc comment — every export needs one                                        |
| VitePress: dead link             | link to `/apps/<app>/` style paths or relative `.md` files that exist               |

## Conventions

- **Tests live next to the code.** `*.test.ts` are unit tests (no services); `*.integration.test.ts`
  need Postgres and/or LiveKit credentials and must skip themselves when those are absent
  (`describe.skipIf`). Browser tests are Playwright specs in `tests/e2e`, load tests Artillery
  profiles in `tests/load`. See [Testing](docs/guide/testing.md).
- **Test first for agent behavior.** Changing prompts or tools? Write or adjust the LLM-as-judge
  eval in `apps/agent/src/agent.integration.test.ts` before touching the prompt.
- **Document as you go.** Every exported symbol gets a TSDoc comment; folders with non-trivial
  logic keep a `README.md` (mermaid diagrams welcome) that VitePress serves. Update both when
  behavior changes.
- **Contracts in one place.** Anything shared between API, agent, web and embed is a zod schema in
  `packages/shared`. Add optional fields with defaults to stay backwards compatible.
- **Keep it small.** The repo has a hard budget of 50k non-blank source lines (`npm run loc`) and a
  POC target below 20k. Prefer deleting to adding.
- **Style** is enforced by Prettier and ESLint; no enums, namespaces or parameter properties
  (Node strips types at runtime, see `tsconfig.base.json`).

Security scanners (`npm run sast`, `npm run dast`) need Docker and run in their own
workflows on `main`; run them locally before touching auth, the public API or dependencies.

## Branches, commits and pull requests

- **Git flow.** `main` holds released code only; day-to-day work branches off `develop`
  as `feature/<topic>` and comes back through a pull request into `develop`. Releases go
  through `release/<version>`, urgent fixes through `hotfix/<version>`; both merge into
  `main` (tagged `v<version>`) and back into `develop`. See [Releasing](docs/guide/releasing.md).
- Small, focused commits with an imperative subject line (`Add …`, `Fix …`), body explaining why.
- One PR per concern; link the TODO.md item or issue it addresses.
- CI must be green. The optional `e2e` job runs only when LiveKit secrets are configured.

## Reporting issues

Use GitHub issues. Include the command you ran, the expected and actual behavior, and the
relevant log (API, agent worker — `tests/e2e/results/agent.log` for e2e runs). Never paste
secrets or `.env.local` contents.
