# Call lifecycle

A call is one row in the `call` table plus its `call_participant`, `transcript_segment` and `call_event` rows, all keyed by the call id, and one LiveKit room named `cc-<tenantId>-<callId>` (`roomNameFor` in `@cc/shared`).

## Status

`CallStatus` in `packages/shared/src/index.ts` is `ringing | ai | waiting_human | human | ended`.

```mermaid
stateDiagram-v2
  [*] --> ringing: POST /api/public/calls inserts the row
  ringing --> ai: ai-first (token carries the agent dispatch)
  ringing --> waiting_human: human-first (Flow.humanFirst rings the queue)
  ai --> waiting_human: escalateToHuman → Flow.escalate
  waiting_human --> human: an agent accepts (Flow.join agent or takeover)
  waiting_human --> ai: nobody accepted (Flow.nobody; human-first also dispatches the AI)
  ai --> human: supervisor take-over
  human --> ended: human agent leaves (Flow.leave → Flow.end)
  ai --> ended: customer hangs up or endCall → agent posts status ended
  waiting_human --> ended: customer hangs up during escalation (agent reports it)
  ended --> [*]
```

Where each transition lives:

| Transition                         | Code                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ringing` → `ai` / `waiting_human` | `apps/api/src/routes/public.ts` right after the token is minted. `ringing` is therefore only the initial insert value; no call stays in it. |
| `ai` → `waiting_human`             | `Flow.escalate`, called by `POST /api/internal/calls/:id/escalate`.                                                                         |
| `waiting_human` → `human`          | `Flow.join` with mode `agent` (desk accept) or `takeover`. `listen` does not change the status.                                             |
| `waiting_human` → `ai`             | `Flow.nobody`, triggered by `Routing` when every eligible agent was tried, declined or timed out, or the human-first deadline passed.       |
| any → `ended`                      | `Flow.end`: deletes the LiveKit room, sets `ended_at`, cancels ringing, resolves a pending escalation with `nobody`. Idempotent.            |

Every status change made through `Flow` emits `call.updated` on the in-process hub, which `/api/ws` fans out to every desk of the tenant. The agent can also set an arbitrary status through `POST /api/internal/calls/:id/status`; in practice it only posts `ended`.

## Call events

`call_event` rows are append-only `{type, payload, at}`. These are the types the code writes:

| Type                   | Written by                                       | Payload                            | When                                                                                      |
| ---------------------- | ------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `call.created`         | API, `routes/public.ts`                          | `{queue, origin}`                  | The call row was inserted.                                                                |
| `ai.joined`            | Agent, `main.ts` via `POST …/events`             | `{}`                               | The worker connected to the room and set `role: ai`.                                      |
| `escalation.requested` | API, `Flow.escalate`                             | `{reason, summary}`                | The `escalateToHuman` tool was called.                                                    |
| `offer.accepted`       | API, `Flow.accepted` (from `Routing.onAccepted`) | `{userId}`                         | The ringing agent pressed Accept.                                                         |
| `offer.nobody`         | API, `Flow.nobody` (from `Routing.onNobody`)     | `{}`                               | Nobody could take the call (all tried / timed out / none online / deadline).              |
| `agent.joined`         | API, `Flow.join` mode `agent`                    | `{userId, name}`                   | Token minted for the accepting agent. The event type is `` `${mode}.joined` ``.           |
| `takeover.joined`      | API, `Flow.join` mode `takeover`                 | `{userId, name}`                   | A supervisor took the call over.                                                          |
| `listen.joined`        | API, `Flow.join` mode `listen`                   | `{userId, name}`                   | A supervisor started listening (subscribe-only token).                                    |
| `handoff`              | Agent, `onHumanJoined`                           | `{to: <human identity>, behavior}` | A participant with `role: human` appeared in the room; `behavior` is `leave` or `listen`. |
| `human.left`           | API, `Flow.leave` role `human`                   | `{userId}`                         | The desk posted `/leave`. This also ends the call.                                        |
| `supervisor.left`      | API, `Flow.leave` role `supervisor`              | `{userId}`                         | A listening supervisor left; the call continues.                                          |
| `call.ended_by_ai`     | Agent, `endCall` tool action                     | `{}`                               | The LLM decided the conversation is over; the worker shuts down three seconds later.      |

The internal `POST …/events` endpoint accepts any `type` string, so the agent can add more without an API change.

## Participants

`call_participant` rows record who was in the room, with `kind` from `ParticipantKind` and the LiveKit identity. The same identities are used as LiveKit participant identities, and the `role` participant attribute (`ParticipantAttributes`) tells every peer who is who.

| Kind          | Identity              | Created by                                        | Notes                                                                                                                                                                                                                |
| ------------- | --------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer`    | `customer:<callId>`   | API when the call is created                      | Display name `Customer`. Attributes `{role: customer}`.                                                                                                                                                              |
| `ai`          | `ai:<callId>`         | Agent via `POST …/participants` after connecting  | Marked left when the worker shuts down, or earlier at a `leave` handoff.                                                                                                                                             |
| `human`       | `human:<userId>`      | API in `Flow.join` (modes `agent` and `takeover`) | `user_id` set. Attributes `{role: human, userId, displayName}`, can publish.                                                                                                                                         |
| `supervisor`  | `supervisor:<userId>` | API in `Flow.join` mode `listen`                  | Subscribe-only token (`canPublish: false`). Same user can have a `human` row from a later take-over.                                                                                                                 |
| `transcriber` | `ai:<callId>`         | Agent after a `leave` handoff                     | **The same LiveKit participant as the AI.** The worker closes the voice session, switches its attribute to `role: transcriber`, marks the `ai` row left and inserts a `transcriber` row with the identical identity. |

The embed button uses the `role` attribute to label the call: `human` shows `Agent <name>`, `ai` shows `AI assistant`, and a `transcriber` or `supervisor` joining never changes the label (`peerLabel` / `reduce` in `apps/embed/src/state.ts`).

## Transcript segments

`transcript_segment` rows carry `speaker` (a `ParticipantKind`), `identity`, `text` and optional `start_ms` / `end_ms`. All of them are posted by the agent worker to `POST /api/internal/calls/:id/transcript`; the API stores them and pushes a `transcript` websocket message to desks that sent `subscribe` for the call.

| Phase                  | Producer                                                                                                                          | Speakers                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| AI conversation        | `AgentSession` `ConversationItemAdded` handler in `apps/agent/src/main.ts`                                                        | `customer` (user messages) and `ai` (assistant messages), identities `customer:<id>` / `ai:<id>`. Only committed chat messages, no timings. |
| After `leave` handoff  | `startTranscriber` (`apps/agent/src/transcriber.ts`) on every remote audio track whose owner has `role` `customer` or `human`     | `customer` and `human`, identity = the speaking participant's identity.                                                                     |
| After `listen` handoff | The still-running `AgentSession` keeps transcribing the customer; a second `startTranscriber` covers only the human agent's track | `customer` from the session, `human` from the transcriber.                                                                                  |

The transcriber uses a fresh `inference.STT` per call and reports only `FINAL_TRANSCRIPT` events. Supervisors listening in are never transcribed.

## The AI summary

When the worker's job shuts down (customer left, `endCall`, or the room was deleted), the shutdown callback in `main.ts` calls `summarize(new inference.LLM({ model: LLM_MODEL }), session.history)` and posts it with `status: ended`; the API stores it in `call.ai_summary`. The prompt asks for two or three plain sentences and has a fixed answer for a caller who never spoke.

**Limitation:** `session.history` only contains what the `AgentSession` saw, i.e. the AI part of the conversation. Whatever the customer and the human agent said after a handoff is in `transcript_segment` but not in the summary. Summary errors are swallowed (`.catch(() => '')`), so a call can end with `ai_summary` null. Generating the summary from the full stored transcript after the call is an open item in `TODO.md`.
