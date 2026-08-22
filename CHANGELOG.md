# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/) (`vMAJOR.MINOR.PATCH` tags, see
[Releasing](docs/guide/releasing.md)).

## [Unreleased]

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

[Unreleased]: https://github.com/ggcaponetto/livekit-playground/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ggcaponetto/livekit-playground/releases/tag/v0.1.0
