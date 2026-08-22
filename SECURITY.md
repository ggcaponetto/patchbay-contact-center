# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Email
[ggcaponetto@gmail.com](mailto:ggcaponetto@gmail.com) with a description, steps to
reproduce and the affected version or commit. You will get an acknowledgement within a
few days; fixes are published as regular commits on `main`.

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
