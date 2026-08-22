# Glossary

**Tenant** — One contact center: a row in `tenant` with a name, a unique slug and a `settings` JSON column (`TenantSettings`). Users can belong to several tenants; the desk picks one with the `x-tenant-id` header (or the first membership). Admin emails get a tenant created for them on first sign-in.

**Queue** — A named pool of agents inside a tenant (`queue` + `queue_member`). Every tenant starts with `support`. The embed button names the queue it calls; escalations ring only agents who are members of that queue.

**Membership / role** — `membership` links a user to a tenant with role `agent` or `supervisor` (`MembershipRole`). Supervisors additionally see the Dashboard and Settings, can administer the tenant and can listen in or take over calls. Invites (`invite`) turn into memberships on first sign-in.

**Embed key** — A public key (`pk_…`, table `embed_key`) that identifies a tenant from a website. Created in Settings, optionally restricted to a list of allowed origins; `POST /api/public/calls` resolves it to the tenant and queue.

**Call** — One customer conversation: a `call` row with status, `room_name`, `customer_meta`, timestamps and `ai_summary`, plus its participants, transcript segments and events. See [Call lifecycle](/docs/guide/call-lifecycle).

**Dispatch** — Asking LiveKit Cloud to start an agent job in a room. The API does it either implicitly, by putting a `RoomAgentDispatch` for `cc-agent` into the customer's token (`ai-first`), or explicitly via `AgentDispatchClient.createDispatch` after humans did not answer (`human-first`). The job metadata is `DispatchMetadata` (call id, tenant, queue, settings, customer meta).

**Room** — The LiveKit WebRTC room for a call, named `cc-<tenantId>-<callId>`. Customer, AI, human agent and supervisors all join the same room. The API deletes it when the call ends.

**Participant attributes** — Key/value metadata on a LiveKit participant. This project sets `role` (`customer`, `ai`, `human`, `supervisor`, `transcriber`), `userId` and `displayName` (`ParticipantAttributes`) so the embed button, the desk and the agent can tell who joined without asking the API.

**Escalation** — The AI handing the conversation to a human. The `escalateToHuman` tool posts reason and summary to `/api/internal/calls/:id/escalate`, the call goes to `waiting_human` and the queue is rung.

**Offer / ring** — One attempt to give a call to one agent. `Routing` sends a `call.offer` websocket message to a single available queue member, waits `offerTimeoutSec` (or `ringSec` from the request), then cancels it and tries the next one. Accepting happens over REST (`/api/desk/calls/:id/accept`) because it returns a LiveKit token; declining is a websocket message.

**Handoff (leave / listen)** — What the AI does when a human agent joins, per tenant setting `handoff.aiBehavior`. `leave`: the voice session closes and the same participant becomes a silent transcriber. `listen`: the AI is interrupted, its audio output disabled, and it keeps listening (there is no "hand back to AI" yet).

**Transcriber** — The AI participant after a `leave` handoff (or an extra STT stream in `listen` mode): `apps/agent/src/transcriber.ts` subscribes to remote audio tracks and posts final STT results as transcript segments for the customer and the human agent.

**Supervisor listen-in / take-over** — Supervisor actions on a live call from the call page. Listen-in joins with a subscribe-only token as `supervisor:<userId>` and leaves the call status untouched; take-over joins as `human:<userId>`, sets the status to `human` and triggers the AI handoff like a normal accept.

**LiveKit Inference** — LiveKit Cloud's hosted model gateway. The agent uses it for STT (`assemblyai/universal-3-5-pro`), the LLM (`google/gemma-4-31b-it`) and TTS (`fishaudio/s2.1-pro`) through `inference.STT / LLM / TTS`, with no provider API keys in the repo.

**Turn detector** — LiveKit's end-of-turn model (`inference.TurnDetector`) that decides when the caller has finished speaking from both audio and semantics, so the AI does not interrupt mid-sentence. Configured in `AgentSession.turnHandling` together with adaptive interruption and preemptive generation.

**LLM-as-judge** — Test technique in the agent evals: an `AgentSession.run()` result is checked by asking a separate LLM whether the assistant's reply fulfils a stated intent, instead of matching exact text. See [Testing](/docs/guide/testing).

**Long-poll** — An HTTP request the server deliberately keeps open until something happens. `/api/internal/calls/:id/escalate` returns only once an agent accepted or nobody could, so the agent's tool call directly yields the outcome.
