# AGENTS.md

This is an AI-first contact center proof of concept built on LiveKit Cloud, organized as an npm-workspaces monorepo. See @README.md for the workspace layout, setup and quality gates.

The following is a guide for working with this project.

## Project structure

This project uses plain **npm workspaces** (`apps/*`, `packages/*`). Always use `npm` (never pnpm/yarn). Workspace scripts: `npm run -w apps/<name> <script>`.

- `apps/agent` is the LiveKit Agents worker; keep `src/main.ts` as its entrypoint (the Dockerfile depends on it).
- `apps/api` (Fastify), `apps/web` (Vite + React + MUI), `apps/embed` (web component with React inside), `packages/shared` (zod contracts) and `packages/i18n` (i18n runtime) are described in the README.
- Every user-facing string of the desk and the call button goes through react-i18next: add the key to **all three** locale files (`src/locales/{en,de,it}/…` in `apps/web`, `src/locales/{en,de,it}.json` in `apps/embed`); the locale tests fail on missing keys. Server data (queue names, codes, roles) stays untranslated.
- Node runs TypeScript directly (type stripping): imports use explicit `.ts` extensions; no enums, namespaces or parameter properties.

## Documentation and tests (keep them in sync with the code)

- Every exported symbol carries a TSDoc comment and every source file starts with a header comment; `npm run docs:build` (typedoc with `notDocumented` validation) fails otherwise. Update the comment when you change behavior.
- Each folder with non-trivial logic has a `README.md` next to the code (architecture, diagrams in mermaid, conventions). VitePress serves the whole repo (`srcDir: '.'`, config in `.vitepress/config.ts`); hand-written guides live in `docs/guide`, the generated API reference in `docs/api`. Add new READMEs to the sidebar in `.vitepress/config.ts`.
- Tests live next to their sources: `*.test.ts` are unit tests (no services), `*.integration.test.ts` need Postgres and/or LiveKit credentials and must skip themselves when those are absent. Browser end-to-end tests are Playwright specs in `tests/e2e`, load tests are Artillery profiles in `tests/load`. See `tests/README.md`.

Quality gates are mandatory: run `npm run validate` before declaring work done. It runs Prettier, ESLint, `tsc`, knip, cspell, the LOC gate (`build/loc.mjs`, 50k hard budget for product code / 20k POC target, tests budgeted separately at 50k), vitest with 90% coverage thresholds on logic modules, and the builds. Add new words to `cspell.json` rather than disabling the check; do not add dependencies before they are used (knip fails otherwise).

## LiveKit Documentation

LiveKit Agents is a fast-evolving project, and the documentation is updated frequently. You should always refer to the latest documentation when working with this project. For your convenience, LiveKit offers both a CLI and an MCP server that can be used to browse and search its documentation. If the developer has not yet installed the CLI, you should recommend that they install it.

### LiveKit CLI

The [LiveKit CLI](https://docs.livekit.io/intro/basics/cli/) `lk docs` subcommand gives full access to LiveKit documentation from the terminal. Requires CLI version 2.15.0+. Check with `lk --version`.

Install or update the CLI:

- **macOS:** `brew install livekit-cli` (update: `brew update && brew upgrade livekit-cli`)
- **Linux:** `curl -sSL https://get.livekit.io/cli | bash`
- **Windows:** `winget install LiveKit.LiveKitCLI` (update: `winget upgrade LiveKit.LiveKitCLI`)

Run `lk docs --help` to see all available commands. Key commands: `lk docs overview`, `lk docs search`, `lk docs get-page`, `lk docs code-search`, `lk docs changelog`, `lk docs submit-feedback`. Run `lk docs <command> --help` before using a command for the first time, as the help text includes advice on usage and interpreting results. Prefer browsing (`overview`, `get-page`) over search, and prefer `search` over `code-search`, as docs pages are more up-to-date and provide better context than raw code.

### LiveKit Docs MCP Server

For deeper IDE integration, LiveKit also offers an [MCP server](https://docs.livekit.io/reference/developer-tools/docs-mcp/) with the same documentation access. It uses Streamable HTTP transport at `https://docs.livekit.io/mcp`. Refer to your IDE's documentation for how to add it.

### Submit docs feedback to LiveKit

If you use the LiveKit CLI or MCP Server to search or browse documentation, also submit constructive feedback to LiveKit with `lk docs submit-feedback` or the MCP `submit_docs_feedback` tool. Add this to your to-do list when planning work, to ensure you file feedback after completing your other tasks. Useful feedback includes incomplete documentation, broken examples, missing steps or any other documentation gap or issue.

## Handoffs ("workflows")

Voice AI agents are highly sensitive to excessive latency. For this reason, it's important to design complex agents in a structured manner that minimizes the amount of irrelevant context and unnecessary tools present on requests to the LLM. LiveKit Agents supports handoffs (one agent hands control to another) to support building reliable workflows. You should make use of these features, instead of writing long instruction prompts that cover multiple phases of a conversation. Refer to the [documentation](https://docs.livekit.io/agents/build/workflows/) for more information.

## Testing

When possible, add tests for agent behavior. Read the [documentation](https://docs.livekit.io/agents/start/testing/), and refer to existing test files with the `.test.ts` extension. Run tests with `npm test`.

Important: When modifying core agent behavior such as instructions, tool descriptions, and tasks/workflows/handoffs, never just guess what will work. Always use test-driven development (TDD) and begin by writing tests for the desired behavior. For instance, if you're planning to add a new tool, write one or more tests for the tool's behavior, then iterate on the tool until the tests pass correctly. This will ensure you are able to produce a working, reliable agent for the user.

## End-to-end test plan (update it on every product iteration)

`tests/e2e/TEST-PLAN.md` is the source of truth for feature coverage: one row per meaningful user-facing behavior, linked by an `@E2E-nn` tag to the Playwright test that proves it. `npm run e2e-plan` (in `validate`) fails when the plan and `tests/e2e/specs` drift, so treat the plan as part of the product:

- **Add** a user-facing behavior (a route, a desk screen or action, an embed state, an AI behavior, a setting) → add a row with the next free id **and** a tagged test in the same change.
- **Change** a behavior → update the row's wording and the test.
- **Remove** a behavior → delete its row and its test (do not leave a dead row or a skipped test).
- Cannot test it yet (needs a product change, real audio, credentials) → add the row with status `planned` or `blocked: <why>` so the gap is visible; move it to `implemented` when the test lands.
- Keep the "Not covered on purpose" section honest: list known bugs and missing features from `TODO.md` there instead of writing tests that assert broken behavior.

Tiers and tags: every test carries exactly one tier — `@smoke` (boot + one happy path per app, < 1 min), `@core` (everything that runs without LiveKit Cloud; the AI is played through `/api/internal`), `@cloud` (real agent worker, real rooms) — plus an area tag (`@embed`, `@desk`, `@supervisor`, `@settings`, `@history`, `@ai`) and its plan id. Put shared steps in `tests/e2e/support` (fixtures, actors, API helpers, page objects), never in a spec. Another signed-in person is `await actor(email)` (the `cc_dev_user` cookie); an agent who gets rung is `await queueAgent(email)`. Run `npm run test:e2e:smoke` while iterating, `npm run test:e2e` before a PR, `npm run test:e2e:cloud` when touching the agent or the handoff. Details: `tests/README.md`, `docs/guide/testing.md`.

## Feature parity with Python SDK

The Node.js SDK for LiveKit Agents has most, but not all, of the same features available in Python SDK for LiveKit Agents. You should always check the documentation for feature availability, and avoid using features that are not available in the Node.js SDK.

## LiveKit CLI

Beyond documentation access, the LiveKit CLI (`lk`) supports other tasks such as managing SIP trunks for telephony-based agents. Run `lk --help` to explore available commands.
