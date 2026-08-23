# TODO

Open items after the first POC iteration (2026-08-22), roughly in priority order.

## Setup

- [ ] Create a Google OAuth client (redirect URI `http://localhost:3000/api/auth/callback/google`) and fill `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env.local`. Until then, `DEV_USER_EMAIL` signs every request in as one user.
- [ ] Port 4000 is taken by NoMachine (`nxd.exe`) on the dev machine. `PORT` (API) and `API_PORT` (web proxy) can be set in `.env.local`; decide whether to change the defaults.
- [ ] Walk through the web desk in a browser (sign-in, availability, ring dialog, in-call panel, dashboard, settings, history). The UI is typechecked, built and unit-tested at the store level only.
- [ ] Add repo secrets for CI: `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (agent evals), `CODECOV_TOKEN`, `SONAR_TOKEN`.

## Testing

- [x] Browser E2E with Playwright (`npm run test:e2e`, optional CI job `e2e`): desk smoke + real call through the embedded button against LiveKit Cloud.
- [x] Load tests with Artillery (`npm run test:load`).
- [ ] Extend the Playwright handoff spec to the human side: a second browser context as the agent accepts the ring and joins the room.

## Deployment

- [ ] Deploy the agent worker to LiveKit Cloud (`lk agent create` / `lk agent deploy` with the existing Dockerfile) so calls work without a laptop running `npm run dev:agent`.
- [ ] Host the API and web desk somewhere with HTTPS; update `WEB_ORIGIN`, `API_ORIGIN` and the Google redirect URI.

## Product / architecture

- [ ] Build out the contact center per [docs/guide/roadmap.md](docs/guide/roadmap.md): Foundations → call control → supervisor → routing → MCP; omnichannel after.

- [ ] MCP server over the stored conversations (`list_calls`, `get_transcript`, `get_events`, `add_note`, ...) so an LLM can decide follow-up actions. The `call`, `transcript_segment` and `call_event` tables are already shaped for this.
- [ ] The AI summary only covers the AI segment of a call (`session.history`); generate it from the full stored transcript instead, after the call ends.
- [ ] `listen` handoff mode keeps the AI muted but never re-engages it; add a "hand back to AI" action for agents.
- [ ] Agent-side ring timeout uses the tenant's `offerTimeoutSec`; there is no overall cap on how long the AI waits for a human during escalation beyond exhausting the queue.
- [ ] Recording consent / audio recordings (LiveKit Egress) if audio, not just transcripts, should be kept.
- [ ] Human-first mode: while the call is still ringing humans (no AI in the room yet), a customer who hangs up leaves the call in `waiting_human`/`ringing` — nobody reports the end. Use a LiveKit webhook (`room_finished`) or have the API watch the room to mark such calls `ended`.
- [ ] `Flow.join(mode: 'takeover')` and `Flow.escalate` accept any non-ended status, so `human → waiting_human` is technically reachable; guard the transitions explicitly.
