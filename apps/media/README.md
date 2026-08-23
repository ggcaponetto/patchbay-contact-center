# Media worker

A small worker that puts **server-side audio** into call rooms — today: music on hold.
It has no HTTP surface: it subscribes to the same Postgres `LISTEN/NOTIFY` channel the
API instances use as their bus (`cc_bus`) and reacts to `media` messages carrying a
`MediaCommand` (contract in `@cc/shared`).

```mermaid
sequenceDiagram
  autonumber
  participant D as Desk (agent)
  participant API as API
  participant PG as Postgres (cc_bus)
  participant M as Media worker
  participant LK as LiveKit room
  D->>API: POST /api/desk/calls/:id/hold
  API->>PG: NOTIFY {kind: media, command: moh.start + token}
  PG->>M: notification
  M->>LK: connect (identity media:callId), publish loop
  Note over LK: customer hears music;<br/>the desk muted itself and unsubscribed
  D->>API: POST /api/desk/calls/:id/retrieve
  API->>PG: NOTIFY moh.stop
  PG->>M: notification
  M->>LK: disconnect
```

## How it works

- `src/music.ts` renders the built-in hold-music loops (`calm`, `bright`): a soft
  pentatonic arpeggio synthesized to 16-bit PCM at 48 kHz — no audio assets to ship or
  license.
- `src/wav.ts` + `src/loops.ts` play a **configured file** instead when the command
  carries a `music` URL (the tenant's `sounds.holdMusic` or the queue's `holdMusicUrl`,
  set in Settings): `loops.ts` fetches it once (relative `/api/public/media/…` paths are
  resolved against `API_ORIGIN`), `wav.ts` decodes PCM / float WAV and mixes it down to
  48 kHz mono, and a small LRU keeps decoded loops in memory. Anything unusable (not a
  WAV, > 20 MiB, non-2xx, shorter than a frame) is logged and falls back to the
  synthesized `style` loop, so a bad upload never means silence.
- `src/worker.ts` is the testable logic: parse bus payloads, keep **one session per
  call**, start on `moh.start` (join with the token the API minted, publish the loop),
  stop on `moh.stop` or when the room closes (call ended). A stop that arrives while the
  join is still in flight is honoured. Restart-safe: a lost session only means the music
  stops until the next hold.
- `src/index.ts` is the entrypoint: `.env.local`, the `pg` LISTEN client, and the LiveKit
  transport (`@livekit/rtc-node`) pushing one 10 ms `AudioFrame` per tick.

The **audibility split** for hold needs no server-side mixing: the customer's embed
auto-subscribes to the new track (hears music), while the desk mutes its own microphone
and unsubscribes from all remote audio (`useLiveRoom.setHeld` in the web app) — so the
customer hears only music and the agent hears silence until Retrieve.

## Running

| Context | How                                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------------- |
| Dev     | `npm run dev` (part of the combined command) or `npm run dev:media`. Needs `DATABASE_URL` and `API_ORIGIN`. |
| e2e     | started by `tests/e2e/global-setup.ts` for the `cloud` tier                                                 |
| Prod    | one process next to the API instances, same `DATABASE_URL`; tokens and LiveKit URLs come with each command  |

## Tests

`src/worker.test.ts` covers the loop rendering (deterministic, clipped, click-free) and
the session lifecycle with a fake transport: start/duplicate/stop, the configured file
resolved before the join, stop-during-resolve and stop-during-connect, room-closed
cleanup, failure logging, shutdown. `src/wav.test.ts` decodes every supported sample
format (hand-built files, odd-sized and unknown chunks) and checks the mono mix-down /
resampling; `src/loops.test.ts` drives the cache with a fake `fetch` (fetch once, LRU,
every rejection rule, fallback). The real LiveKit path is exercised by the
cloud e2e test `tests/e2e/specs/ai/hold-music.spec.ts` (E2E-40).
