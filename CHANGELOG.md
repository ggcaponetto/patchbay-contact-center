# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/) (`vMAJOR.MINOR.PATCH` tags, see
[Releasing](docs/guide/releasing.md)).

## [Unreleased]

### Changed

- Renamed to **Patchbay Contact Center** (`ggcaponetto/patchbay-contact-center`); docs at
  `https://ggcaponetto.github.io/patchbay-contact-center/`.
- LOC gate budgets product code and tests separately (50k each).

### Added

- Dev multi-login: with `DEV_USER_EMAIL` the desk's app bar switches to any person
  (`GET /api/auth/dev-users`, `POST /api/auth/dev-switch`) and a demo team is seeded
  (`DEV_DEMO_TEAM`).
- `docs/guide/roadmap.md`: the contact-center feature list mapped to phases, LiveKit
  mechanisms and line-count estimates.

- End-to-end test plan (`tests/e2e/TEST-PLAN.md`): one tagged Playwright test per feature,
  three execution tiers (`smoke` / `core` / `cloud`), fixtures for several signed-in actors,
  a dedicated `cc_e2e` database, CI jobs per tier and a nightly `E2E` workflow; `npm run
e2e-plan` keeps plan and specs in sync (part of `validate`).
- Dev auth: the `cc_dev_user` cookie selects another dev user per request (development only).

### Fixed

- Opening a call page directly crashed the desk (message sent on a connecting socket).
- New calls now reach the dashboard and history live; the call page shows the queue key
  and keeps transcript rows the socket never saw; switching tenant refetches every query;
  the desk shows "(on a call)" after accepting.

## [0.1.0] — 2026-08-22

First proof-of-concept release, working end to end against LiveKit Cloud.

### Added

- `<cc-call-button>` embeddable web component (`apps/embed`) with per-tenant public keys and
  allowed origins.
- AI agent worker (`apps/agent`) on LiveKit Agents: STT → LLM → TTS pipeline, turn detection,
  noise cancellation, `escalateToHuman` and hang-up tools, transcriber, LLM summary per call.
- Fastify API (`apps/api`): Better Auth with Google sign-in, LiveKit tokens and agent dispatch,
  ring-one-agent-at-a-time routing, desk WebSocket, Drizzle/Postgres persistence of calls,
  participants, transcripts and events; multi-tenant from day one.
- React + MUI desk (`apps/web`) for agents and supervisors: availability, ring dialog, in-call
  panel with live transcript, supervisor dashboard with listen-in / take-over, settings, history.
- Shared zod contracts (`packages/shared`).
- Quality gates: Prettier, ESLint, `tsc`, knip, cspell, LOC budget, vitest with 90 % coverage,
  Playwright e2e and Artillery load suites, typedoc + VitePress documentation site.
- Security scanning: `npm run sast` (npm audit + Semgrep) and `npm run dast` (OWASP ZAP
  baseline against the booted API), both as workflows on `main` with README badges; baseline
  hardening headers on every API response.
- Git-flow branching (`main` / `develop`), semantic-version tags and a `Release` workflow that
  publishes GitHub releases.

[Unreleased]: https://github.com/ggcaponetto/patchbay-contact-center/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ggcaponetto/patchbay-contact-center/releases/tag/v0.1.0
