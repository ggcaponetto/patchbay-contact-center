# Build scripts

## `loc.mjs` — the repo size gate

`npm run loc` (part of `npm run validate` and CI) counts non-blank lines in git-tracked source files and fails when the total exceeds **50 000**. A softer **20 000** POC target prints a warning so drift is visible long before the hard gate trips.

What counts:

- only files listed by `git ls-files`, so generated output (`dist/`, `docs/api/`, `coverage/`) is excluded by construction;
- only code extensions: `.ts .tsx .mts .cts .js .mjs .cjs .jsx .html .css`;
- blank lines are skipped; everything else (comments included) counts.

Markdown, JSON and YAML are config and docs, not code, and are excluded on purpose. Do not dodge the gate by moving logic into an uncounted extension.

The script prints a per-folder breakdown (first two path segments, e.g. `apps/api`) sorted by size, then the total as a percentage of the budget:

```
loc:   3214  apps/api
loc:   1697  apps/web
...
loc:   5577  total (11% of the 50000 budget)
```

### Why

The budget exists for solo-developer maintainability: the repo must stay small enough for one person to hold in their head. Raising `BUDGET` in `build/loc.mjs` is a product decision, not a fix for a failing gate — delete or simplify code instead.

## `e2e-plan.mjs` — the test-plan gate

`npm run e2e-plan` (part of `validate`) parses the coverage table of `tests/e2e/TEST-PLAN.md` and the `{ tag: [...] }` arrays of every spec under `tests/e2e/specs`, then checks that every `implemented` row has exactly one test tagged with its `@E2E-nn` id, every tagged test has a row, the tier tag matches the row, and each test carries exactly one tier and at least one area tag. A `planned` or `blocked` row with a test, or a test without a row, fails the build with the list of problems. No dependencies; runs in well under a second.

## `sast.mjs` — static security scan

`npm run sast` runs `npm audit --omit=dev --audit-level=high` (blocking) and a full `npm audit` (advisory), then Semgrep with the community TypeScript/Node/secrets rulesets — the local `semgrep` binary when present, otherwise the `semgrep/semgrep` Docker image mounted on the checkout. Only ERROR-severity findings fail the run; the JSON and SARIF reports go to `reports/sast/`. Test files are excluded via `.semgrepignore`. Runs in `.github/workflows/sast.yml`.

## `dast.mjs` — dynamic security scan

`npm run dast` starts the API on `DAST_PORT` (default `4010`, dev bypass off, `NODE_ENV=production`) against the local Postgres, waits for `/api/health`, runs the OWASP ZAP baseline scan from `ghcr.io/zaproxy/zaproxy:stable` against `host.docker.internal:<port>`, then stops the API. `zap-rules.tsv` decides which rules are `FAIL` (break the run), `WARN` (reported) or `IGNORE`. The API's root page links the public endpoints so the spider has something to walk. Reports go to `reports/dast/`. Runs in `.github/workflows/dast.yml`.

Both scanners are described in [Quality gates](/docs/guide/quality-gates#security-scans-sast-and-dast).
