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

- Team messaging (Phase 3): supervisors send instant messages to one agent or broadcast
  to every desk (snackbar on any page), and set a persistent ticker banner shown on all
  desks of the tenant (stored in the tenant settings, pushed live and on connect).
- Supervisor monitoring modes (Phase 3): whisper (the agent hears the supervisor, the
  customer never does — the embed skips `monitor: whisper` tracks), barge-in (audible to
  everyone) and intercept (take over + the agent is dropped from the room and freed),
  next to the existing listen and take-over; the agent's desk shows "A supervisor is on
  this call" while monitored (`monitorNotify` tenant setting, on by default).
- Call recording (Phase 2): start / pause / resume / stop from the in-call panel, backed
  by audio-only LiveKit Egress to any S3-compatible store (`RECORDING_S3_*` env vars;
  `RECORDING_STUB=true` exercises the flow without Egress in dev and e2e). A PCI pause is
  a gap between stored segments; every step is journaled as a `recording.*` call event
  and a running segment stops automatically when the call ends.
- Transfers and consultations (Phase 2): blind transfer to a queue or colleague
  (customer parked with music until the target accepts), consultation into the same room
  (customer held; swap = hold/retrieve), completed as hand-over, conference, or drop
  (`removeParticipant`); a call now ends only when the last human leaves.
- Hold / retrieve with music on hold (Phase 2): a new media worker (`apps/media`,
  `@livekit/rtc-node`) joins the room over the Postgres bus and plays a synthesized loop
  to the held customer; the desk shows the hold timer and a hold-too-long reminder
  (`holdReminderSec`). Auto-answer with a zip tone (`autoAnswer` tenant setting).

- Postgres-backed routing engine (Phase 1 Foundations): presence and ring offers move
  from process memory into `agent_presence` / `ring_offer`, so an API restart keeps them
  and several API instances share one engine (periodic `tick`, `FOR UPDATE SKIP LOCKED`).
  A message bus (`bus.ts`, Postgres `LISTEN`/`NOTIFY` in production) reaches desks on any
  instance. Removes the in-memory-routing limitation from `TODO.md`.
- OpenAPI (Phase 1 Foundations): `GET /api/openapi.json`, generated from the routes and
  the zod contracts; a test fails when a route is undocumented.
- RBAC and API keys (Phase 1 Foundations): every route names a permission
  (`calls:read`, `calls:answer`, `calls:supervise`, `tenant:read`, `tenant:write`,
  `api-keys:manage`); roles are permission sets; supervisors create scoped API keys in
  Settings (`/api/admin/api-keys`) that act as bearer tokens on the same routes.
- Contact fields on calls (Phase 1 Foundations): `channel`, `priority`, `requiredSkills`,
  `preferredAgentId`, `language` — the routing inputs every later channel shares. The
  embed sends the customer's language (`language` attribute or `<html lang>`).
- Agent states (Phase 1 Foundations): `ready` / `not_ready` with reason codes /
  `busy` / `acw` with time-in-state, after-call work (timed, extendable, finish early;
  `acwSec` setting), RONA (unanswered ring parks the agent Not ready), supervisor
  force-state / end wrap-up / log out, `GET /api/desk/agents`. State changes are REST
  (`POST /api/desk/state`, `/acw/*`, `/agents/:userId/state`); the `status` socket
  message is gone.
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
