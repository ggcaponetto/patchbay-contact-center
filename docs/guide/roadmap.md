# Roadmap

Where Patchbay Contact Center is going, in what order, and why the whole of it fits the line budget. This page is the product backlog at feature level; `TODO.md` holds the small items, `tests/e2e/TEST-PLAN.md` the per-feature tests.

## The budget question

The repo gate is **50 000 non-blank lines of product code** (tests are budgeted separately, see [Quality gates](/docs/guide/quality-gates)). Today the product is ~6 000 lines. Estimate for everything below:

| Area                                                  | New product lines | Notes                                                            |
| ----------------------------------------------------- | ----------------- | ---------------------------------------------------------------- |
| Foundations (contact model, DB routing, states, RBAC) | 3–4 k             | prerequisite for the rest                                        |
| Agent call control                                    | 6–7 k             | hold, consult, transfer, conference, recording, wrap-up, RONA    |
| Supervisor                                            | 5–6 k             | monitoring modes, whisper/barge/intercept, alerts, dashboards    |
| Routing                                               | 4–5 k             | skills, algorithms, priorities, schedules, callbacks             |
| AI agent growth                                       | 1–2 k             | tools for transfer, dispositions, callbacks                      |
| MCP server                                            | ~1 k              | thin layer over the public API                                   |
| **Total**                                             | **20–25 k**       | **≈ 26–31 k with what exists — fits, with room for omnichannel** |

Tests will be about the same size again (the coverage and e2e-plan gates make them track product code ~1 : 1), which is why they have their own budget.

What keeps it small — five decisions:

1. **One LiveKit room per call, for its whole life.** Consult parties, supervisors, the AI and the customer are all participants of that room. "Who hears whom" is expressed with LiveKit's per-participant **track subscription permissions**, not with audio mixing or extra rooms. Hold, consult, whisper, barge and transfer are permission changes plus state.
2. **A generic `contact` model** (channel = `voice` for now) with routing, states and wrap-up defined on the contact, so chat/email/social later are channel adapters, not a second routing engine.
3. **Routing state in Postgres** (waiting contacts, offers, agent states) instead of the current in-memory `Routing`: restart-safe and multi-instance by construction, and every supervisor view is a query.
4. **A small media worker** (`@livekit/rtc-node`) that publishes server-side audio — music/messages on hold, zip tone — plus **LiveKit Egress** for recordings. No SIP, no PBX in the codebase.
5. **API-first**: every operation is a permissioned route with a zod contract in `packages/shared`; the desk, the AI agent and later the MCP server are just clients. OpenAPI is generated from the contracts.

Out of scope for this round (each would be a later channel or module): PSTN/SIP (LiveKit SIP makes it a dispatch rule + trunk; until then area-code/geo routing and DTMF are moot), digital/omnichannel, outbound dialers, WFM. PCI "pause" of a recording is implemented as stop + start (segments), because Egress cannot pause.

## How each feature maps to what exists

| Feature                           | Mechanism                                                                                                                   |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Answer / reject, RONA             | Today's ring cycle (`Routing.offer`, `offerTimeoutSec`); RONA = timeout → contact back to queue, agent → Not Ready (`rona`) |
| Auto-answer + zip tone            | Offer auto-accepted server-side; the media worker plays the tone to the agent before the customer is audible                |
| Hold / retrieve, music on hold    | Customer unsubscribed from the agent and subscribed to the media worker's hold track; hold timer on the contact             |
| Mute                              | Local track mute (exists)                                                                                                   |
| Consult (one or more parties)     | Extra participants in the room; the customer is not subscribed to them while consulting                                     |
| Alternate / swap                  | Flip which of (customer, consulted party) the agent is subscribed to                                                        |
| Complete as transfer / conference | Transfer: agent leaves, customer subscribed to the consulted party. Conference: everyone subscribed to everyone             |
| Blind transfer                    | Agent leaves; contact re-enqueued on the target (queue, agent, supervisor) with its context                                 |
| Attended transfer                 | Consult, then complete as transfer                                                                                          |
| Recording control                 | LiveKit Egress (room composite); pause = stop + start segments; tags as `call_event`s                                       |
| Notes, tags, dispositions, ACW    | Rows on the contact; ACW is an agent state with a timer and an extend action                                                |
| Agent states, aux codes           | `agent_state` table with reason codes and timestamps; presence broadcast as today                                           |
| Speed dials, colleague presence   | Presence exists; speed dials = internal calls (a contact whose "customer" is an agent)                                      |
| Silent monitor / whisper / barge  | Supervisor joins with permissions: nobody hears them (monitor), only the agent hears them (whisper), everyone (barge)       |
| Intercept / take over             | Exists as take-over; intercept additionally removes the agent (`removeParticipant`)                                         |
| Monitoring notification           | A `call_event` + desk toast/tone, configurable per tenant and legal region                                                  |
| Force state, end wrap-up          | Supervisor routes writing `agent_state`                                                                                     |
| Reskilling on the fly             | Skills/proficiency rows editable live; routing reads them at offer time (as queue membership does today)                    |
| Threshold alerts                  | A periodic evaluator over queue stats → `alert` events → desk banners / wallboard                                           |
| Dashboards / wallboards           | Queries over contacts + agent states; wallboard = a read-only desk route                                                    |
| Messaging                         | Desk websocket messages (`im`, `broadcast`, `ticker`)                                                                       |
| Skills-based routing, algorithms  | Scoring over candidates (idle time, occupancy, proficiency, order) — one function, many strategies                          |
| Priority, aging, sticky routing   | Columns on the waiting contact; preferred agent tried first                                                                 |
| Schedules, holidays, emergency    | Tenant calendar + business hours evaluated at contact creation                                                              |
| Language routing                  | Contact attribute → skill requirement                                                                                       |
| Virtual queue / callback          | Contact stays queued without a room; when an agent is selected the customer is called back (web push / later SIP)           |

## Phases

Each phase adds contracts to `packages/shared`, routes to the API (all public, permissioned), screens to the desk, rows to the e2e plan, and tests next to the code — `npm run validate` at every step.

### 1. Foundations — ✅ done

- **Contact model**: `contact` (channel, queue, priority, skills required, preferred agent, timestamps, outcome) replacing the call-centric columns; `call` stays the voice leg.
- **Routing engine in Postgres**: waiting contacts and offers as rows, selection as a query + scoring function; the in-memory `Routing` becomes a worker loop.
- **Agent states**: Ready / Not Ready (reason) / Busy / ACW / Logged out with time-in-state; replaces the `available|busy|away` presence.
- **RBAC + API keys**: permissions per route (`contact:transfer`, `agent:force-state`, …), roles as permission sets, API keys for integrations with the same permission model.
- **OpenAPI** generated from the zod contracts; webhooks for `contact.*` and `agent.*` events.

### 2. Agent call control

Answer/reject, auto-answer + zip tone, hold/retrieve with music and hold timer, mute, consult (multi-party), swap, complete as transfer / conference / drop, blind and attended transfer to agent / queue / supervisor, recording control, notes/tags/categorization, dispositions (single and multi-level, mandatory/optional), ACW (timed, extendable, auto-exit), caller/call info, speed dials and colleague presence, RONA.

### 3. Supervisor

Monitoring (on demand, next call, by agent, by skill, random/percentage), whisper, barge, intercept, agent-initiated supervisor conference, monitoring notification settings, force state / end wrap-up, reskilling, threshold alerts (queue length, longest wait, service level, abandon rate, long call/hold/ACW), dashboards and wallboards (team, queue, skill, site), messaging (IM, broadcast, ticker).

### 4. Routing

Skills with proficiency (primary/secondary), selection algorithms (longest idle, least occupied, most/least skilled, round-robin, linear, ring all), queue/contact priority with aging, last-agent/preferred/sticky routing, time-of-day/day-of-week/holiday/business-hours routing with emergency and closed modes, language routing, music and messages on hold per queue, virtual queuing / courtesy callback, scheduled callback. Geographic/area-code routing arrives with SIP.

### 5. MCP server

A thin MCP server over the public API (tools = routes, permissions = API key), embeddable in a CRM or an LLM in both directions, so the "act on stored conversations" goal and the live operations share one surface.

### Later

Digital / omnichannel channels (chat, email, social) as adapters on the contact model; SIP/PSTN in and out; workforce management.
