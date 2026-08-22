# TODO

Open items after the first POC iteration (2026-08-22), roughly in priority order.

## Setup

- [ ] Create a Google OAuth client (redirect URI `http://localhost:3000/api/auth/callback/google`) and fill `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env.local`. Until then, `DEV_USER_EMAIL` signs every request in as one user.
- [ ] Port 4000 is taken by NoMachine (`nxd.exe`) on the dev machine. Either change NoMachine's port or make `PORT=4100` the default for the API and the Vite `/api` proxy.
- [ ] Walk through the web desk in a browser (sign-in, availability, ring dialog, in-call panel, dashboard, settings, history). The UI is typechecked, built and unit-tested at the store level only.
- [ ] Add repo secrets for CI: `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (agent evals), `CODECOV_TOKEN`, `SONAR_TOKEN`.

## Testing

- [ ] Browser E2E with Playwright (optional CI job): sign in via `DEV_USER_EMAIL`, create an embed key in Settings, open the embed demo page, press "Call us" with a fake microphone (`--use-fake-device-for-media-stream`), assert the AI status chip appears. Needs Postgres and the agent worker running.
- [ ] The end-to-end handoff was verified with a throwaway Node script (rtc-node + ws) against LiveKit Cloud; consider keeping a versioned `scripts/e2e-handoff.mjs` for regression checks.

## Deployment

- [ ] Deploy the agent worker to LiveKit Cloud (`lk agent create` / `lk agent deploy` with the existing Dockerfile) so calls work without a laptop running `npm run dev:agent`.
- [ ] Host the API and web desk somewhere with HTTPS; update `WEB_ORIGIN`, `API_ORIGIN` and the Google redirect URI.

## Product / architecture

- [ ] MCP server over the stored conversations (`list_calls`, `get_transcript`, `get_events`, `add_note`, ...) so an LLM can decide follow-up actions. The `call`, `transcript_segment` and `call_event` tables are already shaped for this.
- [ ] The AI summary only covers the AI segment of a call (`session.history`); generate it from the full stored transcript instead, after the call ends.
- [ ] Routing state (presence, ringing offers) is in-memory in the API process; a restart drops it until desks reconnect. Fine for the POC, revisit before multi-instance deployment.
- [ ] `listen` handoff mode keeps the AI muted but never re-engages it; add a "hand back to AI" action for agents.
- [ ] Agent-side ring timeout uses the tenant's `offerTimeoutSec`; there is no overall cap on how long the AI waits for a human during escalation beyond exhausting the queue.
- [ ] Recording consent / audio recordings (LiveKit Egress) if audio, not just transcripts, should be kept.
