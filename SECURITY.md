# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Email
[ggcaponetto@gmail.com](mailto:ggcaponetto@gmail.com) with a description, steps to
reproduce and the affected version or commit. You will get an acknowledgement within a
few days; fixes are published as patch releases (`hotfix/*` → `main`, tagged `vX.Y.Z`).

## Automated scans

Every push to `main` runs a static scan (`npm audit` on production dependencies plus
Semgrep) and a dynamic scan (OWASP ZAP baseline against the booted API); see
[Quality gates](docs/guide/quality-gates.md). Known, accepted findings:

- `vite` ≤ 6 (high, dev server only) through `vitepress` 1.x: affects `npm run docs:dev`
  on a developer machine, not any deployed component. Re-evaluated on each release.

## Scope and known limitations

This is a proof of concept. Things to be aware of before exposing it to the internet:

- `DEV_USER_EMAIL` disables authentication; it is ignored when `NODE_ENV=production`,
  but never set it on a reachable deployment.
- Embed keys are public by design; restrict them with allowed origins in Settings.
  Origin checks rely on the browser-sent `Origin` header.
- The internal API used by the agent worker is protected by a single shared secret
  (`INTERNAL_API_SECRET`); rotate it like any credential.
- Transcripts and summaries contain personal data; apply your retention rules to the
  `transcript_segment`, `call_event` and `call` tables.
