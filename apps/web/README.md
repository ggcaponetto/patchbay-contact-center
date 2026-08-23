# Agent desk (`apps/web`)

The browser app that human agents and supervisors use: go available, get rung, talk to
customers, watch live calls, read transcripts and configure the tenant. It is a plain
Vite + React 19 single-page app with MUI 9 for UI, TanStack Query for REST data and a
websocket for everything that happens in real time.

It talks to `apps/api` only. LiveKit media goes straight from the browser to the LiveKit
server using tokens the API hands out.

## Running it

```bash
npm run dev:web          # Vite dev server on http://localhost:3000
```

| Variable   | Default | Meaning                                                                    |
| ---------- | ------- | -------------------------------------------------------------------------- |
| `WEB_PORT` | `3000`  | Port of the Vite dev server.                                               |
| `API_PORT` | `4000`  | Where `/api` (REST **and** websocket) is proxied to, see `vite.config.ts`. |

The proxy keeps every request same-origin so the Better Auth session cookie is
first-party and no CORS setup is needed in development. The API must be running
(`npm run dev:api`); the AI agent worker is only needed to actually take calls.

`npm run build -w apps/web` produces a static `dist/` that can be served by any web
server that forwards `/api` to the API.

### Signing in

Sign-in is Better Auth with Google as the only provider. The button calls
`authClient.signIn.social({ provider: 'google' })`, the API completes the OAuth dance
and sets the session cookie. A user then needs a **membership** in a tenant (created by
a supervisor invite, matched on the Google email) to see anything.

For local work set `DEV_USER_EMAIL=you@example.com` in the API's environment
(non-production only). The API then answers `/api/auth/get-session` with that user,
bootstraps a tenant for them and no Google round-trip happens. The Playwright tests rely
on this.

The app bar then shows **Signed in as …** (`components/DevUserMenu.tsx`). The identity is
**per browser tab**: `lib/devUser.ts` keeps the chosen email in `sessionStorage`
(`cc_dev_user`), `lib/api.ts` sends it as the `x-dev-user` header on every request (the
Better Auth client included, through `customFetchImpl`) and `useDeskSocket` adds
`&as=<email>` to the websocket URL. Switching in the menu re-renders the desk without any
server round-trip; **Open in new tab** next to a person opens `#/?as=<email>`, which
`bootDevUser()` (called in `main.tsx` before rendering) reads, stores and strips from the
URL. A tab opened any other way starts as the default dev user.

## Structure

```
src/
  main.tsx              Providers (i18n, MUI theme + locale, QueryClient, ToastProvider) and mount
  App.tsx               session gate → SignIn | Shell (tabs, tenant selector, desk socket)
  pages/
    Desk.tsx            #/desk        availability, offer dialog, active call
    Dashboard.tsx       #/dashboard   live calls + presence (supervisors)
    History.tsx         #/history     all calls of the tenant
    CallPage.tsx        #/calls/<id>  transcript, events, listen-in / take-over
    Settings.tsx        #/settings/<tab>  tabs (supervisors), one card per tab
  components/
    CallPanel.tsx       in-call view + Transcript list
    ConfirmButton.tsx   "Are you sure?" dialog for destructive actions
    LanguageMenu.tsx    app-bar language selector (English / Deutsch / Italiano)
    ApiKeysCard.tsx     Settings → API keys (create, revoke, delete)
    settings/           one card per settings tab: RoutingCard (+ CodesEditor for wrap-up
                        codes, SkillCatalogEditor for routing skills), HoursCard, TeamCard
                        (+ SkillsEditor chips), QueuesCard,
                        SoundsCard (hold music / ringtone / ringback: URL or upload), EmbedCard
  lib/
    api.ts              fetch wrapper, auth client, DTO types, uploadMediaAsset
    store.ts            pure reducer for websocket messages + helpers (unit-tested)
    hooks.ts            useDeskSocket, useLiveRoom, useRoute, useNow
    sounds.ts           zip tone, built-in ring, useRingtone (tenant ringtone URL or synth)
    useToast.tsx        the one snackbar every settings save confirms itself in; errorText()
    i18n.ts             createWebI18n, MUI_LOCALES, useLocaleFormat (dates in the user's language)
  locales/
    en/ de/ it/         translation.json (desk) + settings.json (settings cards) per language
  i18next.d.ts          typed translation keys from the English files
```

```mermaid
flowchart TD
  main[main.tsx<br/>I18nextProvider · ThemeProvider · QueryClientProvider] --> App
  App -- no session --> SignIn
  App -- session --> Shell
  Shell --> Desk & Dashboard & History & CallPage & Settings
  Desk --> CallPanel
  CallPage --> CallPanel

  subgraph data [Data flow]
    REST[(REST /api/*)] -- useQuery / useMutation --> pages[pages]
    WS[(websocket /api/ws)] -- ServerMessage --> reduce[store.reduce] --> state[desk.state]
    state --> pages
    state -- callsVersion in query keys --> REST
  end
```

Two things are worth knowing up front:

- **There is no router.** `location.hash` is parsed by `parseRoute` in `lib/store.ts`
  and `useRoute` re-renders on `hashchange`. Navigate by assigning `location.hash`.
- **There is no global store library.** `useDeskSocket` (called once in `Shell`) owns a
  `useReducer` over `store.reduce`; its return value is passed to pages as the `desk`
  prop. REST data lives in TanStack Query.

## Pages

| Route          | Who         | Shows                                                                                                                                      | Endpoints / messages                                                                                                                                                         |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#/desk`       | everyone    | `StateBar` (Ready / Not ready + reason, timer, wrap-up), incoming-call dialog (rings: built-in tone or the tenant's ringtone), `CallPanel` | `POST /desk/state`, `/desk/acw/*`, `GET /desk/settings`; WS `offer.decline`, `subscribe`; `POST /desk/calls/:id/accept`, `/leave`                                            |
| `#/dashboard`  | supervisors | Live calls with duration + status chip, agents with state, reason and timer, force-state menu                                              | `GET /desk/calls`, `POST /desk/agents/:userId/state`; WS `presence`, `call.updated`                                                                                          |
| `#/history`    | everyone    | Table of all calls (started, queue, status, duration, summary)                                                                             | `GET /desk/calls`; WS `call.updated` (re-fetch)                                                                                                                              |
| `#/calls/<id>` | everyone    | Transcript, AI summary, event log; supervisors: listen in / take over                                                                      | `GET /desk/calls/:id`; WS `subscribe`, `transcript`; `POST /desk/calls/:id/join` (`listen`/`takeover`), `/leave`                                                             |
| `#/settings`   | supervisors | Tabs: Routing & AI (incl. wrap-up codes), Business hours, Team & skills, Queues, Sounds, Call button, API keys                             | `GET/PATCH /admin/tenant…`, `GET/POST /admin/members`, `/admin/invites`, `/admin/queues…` (incl. `DELETE`), `/admin/media-assets…`, `/admin/embed-keys…`, `/admin/api-keys…` |

All REST paths are relative to `/api`; the `api()` helper adds the prefix, the session
cookie and the `x-tenant-id` header. The websocket is `/api/ws?tenantId=…`. Message
shapes (`ServerMessage`, `ClientMessage`) are zod schemas in `packages/shared`.

## The agent's day: desk state machine

```mermaid
stateDiagram-v2
  [*] --> away: socket connects (initialState)
  away --> available: toggle → WS status
  available --> away: toggle → WS status
  available --> ringing: WS call.offer
  ringing --> available: Decline (WS offer.decline)<br/>or call.offer.cancelled<br/>or expiresAt passes
  ringing --> in_call: Accept → POST /accept → token<br/>WS subscribe
  in_call --> available: Hang up, or customer leaves<br/>→ POST /leave {role: human}<br/>→ setStatus(available)
  state ringing {
    [*] --> dialog
    dialog: Dialog with queue, reason, summary<br/>and a countdown from secondsLeft()
  }
  state in_call {
    [*] --> room
    room: CallPanel · useLiveRoom<br/>Room.connect, mic on,<br/>remote audio attached, live transcript
  }
```

Notes for the curious:

- The server routes offers one agent at a time; `expiresAt` is when it moves on. The
  countdown is purely cosmetic, the reducer keeps the offer until a
  `call.offer.cancelled` or an `ended` `call.updated` arrives, or the user acts.
- The agent's own state is never set optimistically: the `StateBar` posts to
  `/api/desk/state` and shows whatever the next `presence` frame says (`myPresence`
  in `store.ts`). The server sets `busy` on accept and `acw` after hang-up.
- `CallPanel` calls `onLeave` on its own when no peer with `role: customer` is left in
  the room, so an agent is never stuck in an empty room.
- After a reconnect of the websocket the API sees a new connection, i.e. the agent is
  `not_ready` again — and, since the state comes from the server, the desk shows that.
- A `logout` frame (supervisor forced it) stops the reconnect loop and shows a banner.

## Attribute-based routing in the desk

When the AI hands over it tags the call with skill keys from the tenant's **routing skill
catalogue** and the caller's language; the API routes to matching agents and the desk
shows what was asked for. The ring dialog lists the pinned skills and the language as
chips (`skillLabel` in `lib/store.ts` turns `vip` into its catalogue label and `lang:it`
into "Language: Italiano") plus a warning chip "Requirements relaxed" once the queue's
`relaxAfterSec` dropped the skills. The call page repeats the chips in its header and
narrates the `escalation.requested` / `escalation.relaxed` events; History has a Skills
column (hidden on phones). The catalogue itself is edited in Settings → Routing & AI
("Routing skills": label, key derived from the label, description for the AI); its keys
are suggested in every skills editor (Team & skills, queue requirements), and each queue
sets "Relax skill requirements after (s, 0 = never)".

## Supervisors: listen in and take over

On a live call's page (`#/calls/<id>`) a supervisor gets two buttons. Both call
`POST /api/desk/calls/:id/join` with a `mode` and render the same `CallPanel` with the
returned token:

| Mode       | `publish` | Role sent on leave | Effect                                                                                       |
| ---------- | --------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `listen`   | `false`   | `supervisor`       | Joins silently (no microphone). Leaving does not affect the call.                            |
| `takeover` | `true`    | `human`            | Joins as a human agent; the AI applies the tenant's handoff behavior. Leaving ends the call. |

## `lib/` in more detail

**`api.ts`** — `authClient` (Better Auth React client, base path `/api/auth`), the DTO
types the pages consume (`Me`, `CallSummary`, `CallDetail`, `Tenant`, `Queue`,
`Member`, `Invite`, `EmbedKey`) and the `api` / `post` / `patch` / `put` / `del`
helpers. `setTenant` stores the tenant id used for the `x-tenant-id` header; `Shell`
calls it whenever the selected membership changes. Non-2xx responses throw an
`ApiError` whose message is the API's `error` code (`not_ringing_you`, `call_over`…).

**`store.ts`** — `reduce(state, action)` and `initialState`. Actions are either local
(`socket`, `myStatus`, `offer.clear`) or `{ type: 'server', message }` wrapping a
`ServerMessage`. The reducer keeps: connection flag, own status, current offer, presence
list, latest status per call, live transcript segments per call, the hold state per
call (`held`, from the `call.updated` frames that carry `heldAt`) and `callsVersion`,
a counter bumped on every `call.updated`. Helpers: `secondsLeft`, `formatDuration`,
`statusLabel` / `statusColor`, `parseRoute`, `speakerLabel` (transcript speaker →
"Ann · Agent", "Customer 1a2b3c4d", "AI assistant"). Everything here is pure and
covered by `store.test.ts`.

**`hooks.ts`**

- `useDeskSocket(tenantId)` opens the websocket, feeds every frame to the reducer and
  reconnects two seconds after any close until unmounted. Returns
  `{ state, dispatch, send, setStatus }`. `send` silently drops messages while the
  socket is not open.
- `useLiveRoom(join)` wraps a `livekit-client` `Room`: connects with `join.token`,
  enables the microphone when `join.publish`, attaches every subscribed audio track into
  the element referenced by `audioRef`, tracks remote peers (identity, name, `role`
  attribute) and exposes `toggleMute` and `setHeld`. Disconnects on unmount or when
  `join` changes. `setHeld` is serialized (calls queue behind each other and the latest
  requested state wins), unsubscribes remote audio before the microphone round-trip,
  skips the `media` participant and removes detached `<audio>` elements on
  `TrackUnsubscribed`.
- `useRoute()` and `useNow()` are the tiny helpers described above.

## Conventions

- **Styling**: MUI components with the `sx` prop. No CSS files, no styled-components
  beyond what MUI brings.
- **Routing**: hash routes only; add cases to `Route` / `parseRoute` rather than a
  router dependency.
- **Server data**: `useQuery` with array keys. Lists that must refresh when a call
  changes include `desk.state.callsVersion` in their key (`['calls', callsVersion]`),
  so a `call.updated` websocket frame is all it takes to re-fetch. Anything a control
  depends on (the hold button, recording state) must **not** use a key that changes —
  `data` is `undefined` while a new key loads and the control flickers. Keep the key
  stable (`['call', id]`) and `invalidateQueries` when `callsVersion` changes: the old
  data stays until the new one arrives. Prefer the socket's value where it exists
  (`state.held[id]` over `detail.heldAt`). Mutations call `invalidateQueries` on success.
- **Feedback**: every settings mutation reports through `useToast()` (`onSuccess` →
  "… saved", `onError` → the API's error code) and disables its button while pending.
  Destructive actions go through `ConfirmButton`. No free-text mini-languages in forms:
  skills are chips (`SkillsEditor`), wrap-up codes are rows (`CodesEditor`).
- **Settings cards** own their keys: `RoutingCard` sends only `routingSettings()`,
  `HoursCard` only `{ hours }`, `SoundsCard` only `{ sounds }` — the API merges
  shallowly, so a card must never PATCH the whole settings object.
- **Real-time data**: never read the websocket directly in a page; extend `DeskState`
  and `reduce` and add a unit test.
- **Props over context**: pages receive `desk` (and `me` / `supervisor` where needed)
  from `Shell`.
- **Formatting/linting**: root `npm run format` and `npm run lint`; imports are sorted
  by the prettier plugin.

## Accessibility and responsiveness

The desk is used on laptops but also checked on a phone (`tests/e2e/specs/desk/mobile.spec.ts`,
390 px wide). The conventions:

- **Landmarks and headings**: `Shell` renders the page inside `<main id="main">`, with a
  "Skip to content" link that is visually hidden until focused. Every page renders
  exactly one `h1` (`<Typography variant="h5" component="h1">`, e.g. "Desk", "Calls",
  "Settings"); cards use `component="h2"`. Big numbers on the wallboard are `div`s,
  not headings.
- **Theme defaults** (`main.tsx`): `MuiTabs` are `scrollable` with scroll buttons on
  mobile, so tab strips never overflow; `MuiButtonBase` gets a visible focus ring
  (`.Mui-focusVisible`); `responsiveFontSizes` scales the headings down on phones.
- **App bar**: below the `md` breakpoint the language select, tenant select, dev-user
  menu and Sign out fold into an account `IconButton` (`aria-label` "Account") that
  opens a `Menu` with the same controls. Above `md` they are inline.
- **Layout**: rows of buttons and inputs are `Stack direction="row"` with
  `flexWrap: 'wrap', rowGap`; fixed input widths become responsive
  (`{ xs: '100%', sm: 200 }`). Tables sit in a `TableContainer` with
  `overflowX: 'auto'` and hide secondary columns on `xs` (`display: { xs: 'none', md:
'table-cell' }`); the page body must never scroll horizontally.
- **Keyboard**: clickable table rows carry `tabIndex={0}`, an `aria-label` and open on
  Enter / Space. Icon-only buttons always have an `aria-label`. Primary actions keep the
  default button size (40 px touch target); `size="small"` is for secondary actions in
  dense lists.
- **Dialogs and live regions**: the incoming-call dialog is `fullScreen` below `sm`,
  has `aria-labelledby` / `aria-describedby`, focuses Accept and announces the
  countdown with `aria-live="polite"`; the transcript list is `aria-live="polite"` too.
- **Locators**: the Playwright page objects (`tests/e2e/support/pages.ts`) find things
  by role and name — keep headings, labels and button texts stable when restyling.

## Internationalization

The desk speaks English, German and Italian. The runtime is
[react-i18next](https://react.i18next.com/) on top of the shared `@cc/i18n` package
(`packages/i18n`: supported languages, cookie, `createI18n`); the desk-specific wiring is
in `src/lib/i18n.ts`.

- **Namespaces**: `src/locales/<lng>/translation.json` holds everything outside the
  settings area, nested by screen (`app.*`, `desk.*`, `dashboard.*`, `history.*`,
  `call.*`, `wallboard.*`, `stateBar.*`, `callPanel.*`, `recording.*`, `transfer.*`,
  `notes.*`, `messages.*`, `devUser.*`, `common.*`, `states.*`, `statuses.*`,
  `errors.*`); `settings.json` is the `settings` namespace used by the settings cards
  (`useTranslation('settings')`). Leaves are camelCase; plurals use i18next's
  `key_one` / `key_other` with `count`; `<Trans>` only where inline markup is needed
  (the "not a member" alert).
- **Typed keys**: `src/i18next.d.ts` derives the key types from the English files, so
  `t('desk.accept')` is checked by `tsc`. `stateKey(state)` / `statusKey(status)` in
  `lib/store.ts` return `states.<state>` / `statuses.<status>` for the chips.
- **Language detection and switching**: `detectLanguage()` reads the `cc_lng` cookie,
  else `navigator.language`; `LanguageMenu` in the app bar calls `i18n.changeLanguage`
  and `persistLanguage` (cookie, one year). `Providers` in `main.tsx` re-creates the MUI
  theme with the matching locale bundle (`MUI_LOCALES`) and keeps `<html lang>` in sync.
  Dates and times go through `useLocaleFormat()` (`Intl.DateTimeFormat` in the current
  language); durations (`m:ss`) are language-neutral.
- **Errors**: the API answers with codes (`on_call`, `last_queue`…); `errorText(e, i18n)`
  in `lib/useToast.tsx` maps them through `errors.<code>` and falls back to the bare
  code for anything unknown.
- **Adding a key**: add it to `en/translation.json` (or `settings.json`) **and** to `de`
  and `it` — `src/locales/locales.test.ts` fails on missing keys, empty values, different
  `{{placeholders}}` or unpaired plurals, and checks that every `AgentState`,
  `CallStatus` and API error code has a label.
- **Adding a language**: extend `SUPPORTED_LANGUAGES` / `LANGUAGE_NAMES` in
  `packages/i18n`, add the two JSON files under `src/locales/<lng>/`, register them in
  `createWebI18n` and the MUI bundle in `MUI_LOCALES`, and add the folder to
  `cspell.json` `ignorePaths`.
- **Tests**: `tests/setup/i18n.ts` (vitest `setupFiles`) registers the English instance
  as react-i18next's default, so components render English without a provider; the e2e
  suite pins `cc_lng=en` on every browser context and `desk/language.spec.ts` switches
  to German on purpose.
- **What stays untranslated**: anything that comes from the server or the tenant —
  queue names and keys, not-ready reasons, roles and permissions, threshold alerts,
  ticker and instant-message text, event types, tags, speaker and role codes, wrap-up
  code labels, the native language names in the menu.

## Adding a page

1. Add a variant to `Route` and a case to `parseRoute` in `lib/store.ts`; extend the
   `parses hash routes` test in `store.test.ts`.
2. Create `src/pages/MyPage.tsx` exporting a component that takes `desk` (and anything
   else it needs) as props. Fetch with `useQuery`, include `callsVersion` in the key if
   the data changes with calls.
3. Render it in `Shell` (`App.tsx`) behind `route.page === 'mypage'`, gated by
   `supervisor` if needed, and add a `<Tab value="mypage" />`. Map the route to a tab
   value if it is a sub-page (see how `call` maps to `history`).
4. If it needs new server data, add the DTO type to `lib/api.ts` next to the endpoint
   it mirrors.
5. Run `npm run typecheck`, `npm run lint`, `npm run test:unit` and, ideally, add a
   Playwright scenario.

## Testing

- **Unit**: `src/lib/store.test.ts` (Vitest, jsdom) covers the reducer, countdown,
  duration formatting and route parsing. Run with `npm run test:unit` from the root.
  Components and hooks are not unit-tested; keep logic in `store.ts` where it is cheap
  to test.
- **End-to-end**: `tests/e2e/desk.spec.ts` (Playwright) signs in through
  `DEV_USER_EMAIL`, toggles availability, checks the dashboard and creates an embed key
  in Settings. `tests/e2e/handoff.spec.ts` drives a real call through the embed button
  and needs LiveKit Cloud credentials. Run with `npm run test:e2e`.
