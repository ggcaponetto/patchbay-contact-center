# Quality gates

`npm run validate` is the definition of done: it runs everything CI runs, in the same order, and must pass before work is declared finished (see `AGENTS.md`).

## The `validate` pipeline

```console
npm run format:check && npm run lint && npm run typecheck && npm run knip && npm run spell && npm run loc && npm test && npm run build && npm run docs:build
```

| Step       | Command                                            | What it checks                                                                                                                                                                                                                                                                                                                  |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting | `prettier --check .`                               | Every file is Prettier-formatted, imports sorted by `@trivago/prettier-plugin-sort-imports`. Fix with `npm run format`.                                                                                                                                                                                                         |
| Lint       | `eslint .`                                         | Flat config in `eslint.config.ts` (`@eslint/js` + `typescript-eslint`). Fix with `npm run lint:fix`.                                                                                                                                                                                                                            |
| Types      | `npm run typecheck` → `tsc --noEmit` per workspace | Each app and package has its own `tsconfig.json` extending `tsconfig.base.json` (strict, `erasableSyntaxOnly`, `allowImportingTsExtensions`).                                                                                                                                                                                   |
| Dead code  | `knip`                                             | Unused files, exports, dependencies and devDependencies, configured per workspace in `knip.json`.                                                                                                                                                                                                                               |
| Spelling   | `cspell --no-progress "**"`                        | Unknown words in every non-ignored file. Project words live in `cspell.json`.                                                                                                                                                                                                                                                   |
| Size       | `node build/loc.mjs`                               | Non-blank tracked source lines; fails above 50 000, warns above 20 000. See [Build scripts](/build/).                                                                                                                                                                                                                           |
| Tests      | `vitest run --coverage`                            | Unit + integration projects and the 90% coverage threshold on logic modules. See [Testing](/docs/guide/testing).                                                                                                                                                                                                                |
| Builds     | `npm run --workspaces --if-present build`          | Vite builds of `apps/web` and `apps/embed` (the API and agent have no build step).                                                                                                                                                                                                                                              |
| Docs       | `typedoc` then `vitepress build .`                 | The API reference is generated into `docs/api` with `treatWarningsAsErrors` and `validation.notDocumented`, so every exported class, function, interface, type alias, variable and module needs a doc comment. VitePress then builds the site with `ignoreDeadLinks: false`, so every link in every markdown page must resolve. |

## Git hooks

Husky (installed by `npm install` through the `prepare` script):

- **pre-commit**: `npx prettier --check .` and `npm run typecheck`.
- **pre-push**: `npm run validate`.

If a hook fails, fix the cause; do not use `--no-verify`.

## CI

`.github/workflows/ci.yml` runs on pushes to `main` and `contact-center-poc`, on pull requests and manually. It is a three-OS matrix (Ubuntu, Windows, macOS) with `fail-fast: false`:

- OS-independent gates (format, lint, knip, cspell, loc, docs) run only on Linux.
- `typecheck` and `build` run everywhere.
- `npm test` with coverage runs on Linux, which has a Postgres container; the other runners run vitest without coverage and the DB suites skip.
- Agent evals run only when the `LIVEKIT_*` repository secrets exist.

**Codecov** (`codecov.yml`) receives `coverage/lcov.info` and **SonarQube** (`sonar-project.properties`) scans the checkout; both run only when their token secret is set and are informational — `fail_ci_if_error: false`, no quality gate blocks the workflow. The hard gate is vitest's 90% threshold.

The separate `docs.yml` workflow builds the VitePress site and publishes it to GitHub Pages on pushes to `main` that touch `docs/**`, `packages/shared/**` or `typedoc.json`.

## Fixing typical failures

**knip: unused dependency / unused export.** Knip lists the package or symbol. Either use it or remove it (`npm uninstall <pkg> -w apps/<name>`). Do not add a dependency "for later"; install it in the same change that imports it. For a file that is an entrypoint knip cannot infer (a script, a config), add it to `entry` in `knip.json`.

**cspell: Unknown word (foo).** If it is a real identifier, product name or term, add it to the `words` array in `cspell.json`, keeping the array sorted case-insensitively (Prettier does not sort it for you). Do not add typos, and do not add `cspell:disable` comments. Generated folders are already in `ignorePaths`.

**Coverage threshold not met.** The vitest summary shows the uncovered file and lines. Add tests for the logic; if the uncovered code is genuinely wiring (a LiveKit or Fastify adapter with no branches worth testing), move it into a module that is excluded by `vitest.config.ts` rather than lowering the threshold. Locally, the coverage gate only means something when Postgres is running — with it stopped the integration suites skip and coverage collapses.

**typedoc: X does not have any documentation.** Every export listed in `requiredToBeDocumented` needs a `/** … */` comment. One sentence saying what it is for is enough. `typedoc.json` excludes tests, `testing.ts` and `main.tsx`.

**VitePress: dead link.** Links use absolute paths without extension (`/docs/guide/architecture`, `/apps/api/`). A folder link needs a `README.md` or `index.md` in that folder.

**LOC gate.** The budget is deliberate; delete or simplify code instead of raising `BUDGET` in `build/loc.mjs`.
