# Getting started

This guide takes you from a fresh clone to your first call with the AI agent, running every app on your machine against LiveKit Cloud.

## Prerequisites

- **Node.js 24+** (see `.nvmrc`) and **npm 11+**. The repo uses plain npm workspaces; never use pnpm or yarn.
- **Docker** for Postgres (`docker-compose.yml`).
- The **[LiveKit CLI](https://docs.livekit.io/intro/basics/cli/)** 2.15+ and a LiveKit Cloud project. Install with `brew install livekit-cli` (macOS), `curl -sSL https://get.livekit.io/cli | bash` (Linux) or `winget install LiveKit.LiveKitCLI` (Windows).
- A **Google OAuth 2.0 client** for desk sign-in, or use the dev auth bypass (`DEV_USER_EMAIL`, see below) to skip it for now.

## Clone and install

```console
git clone https://github.com/ggcaponetto/patchbay-contact-center.git
cd patchbay-contact-center
npm install
```

`npm install` also sets up the Husky git hooks (`prepare` script).

## Configure `.env.local`

Copy the example file and fill it in. Every app loads `.env.local` from the repo root (the API and agent look in their own folder first, then `../../.env.local`).

```console
cp .env.example .env.local
lk cloud auth
lk app env -w -d .env.local      # writes LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
```

| Variable                                   | Used by                | Default                              | Purpose                                                                                                                                                                       |
| ------------------------------------------ | ---------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIVEKIT_URL`                              | API, agent             | —                                    | Your LiveKit Cloud project URL (`wss://…`). The API refuses to start without all three `LIVEKIT_*` values.                                                                    |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`    | API, agent, evals, e2e | —                                    | Cloud credentials used to mint tokens, dispatch the agent and delete rooms. Agent evals and the handoff e2e test skip themselves when the key is absent.                      |
| `PORT`                                     | API                    | `4000`                               | Port the Fastify API listens on.                                                                                                                                              |
| `WEB_ORIGIN`                               | API                    | `http://localhost:3000`              | Origin of the web desk. Better Auth uses it as `baseURL` and trusted origin, so Google redirects back to the desk (which proxies `/api` to the API).                          |
| `API_ORIGIN`                               | Agent                  | `http://localhost:4000`              | Where the agent worker reaches `/api/internal/*`. Must be a URL the worker can resolve (public URL once the agent runs in LiveKit Cloud).                                     |
| `DATABASE_URL`                             | API, tests             | `postgres://cc:cc@localhost:5432/cc` | Postgres connection string. Migrations run automatically when the API boots.                                                                                                  |
| `INTERNAL_API_SECRET`                      | API, agent             | —                                    | Shared secret sent as the `x-internal-secret` header by the agent worker. The API refuses to start when it is empty; a mismatch makes every agent call fail with 401.         |
| `ADMIN_EMAILS`                             | API                    | —                                    | Comma-separated emails. On first sign-in such a user gets a tenant of their own (with a `support` queue) and becomes its supervisor; they may also `POST /api/admin/tenants`. |
| `BETTER_AUTH_SECRET`                       | API                    | —                                    | Secret for Better Auth session cookies. Use a random string of at least 32 characters.                                                                                        |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | API                    | —                                    | Google OAuth client for the desk sign-in.                                                                                                                                     |
| `DEV_USER_EMAIL`                           | API                    | unset                                | Dev only: every request is signed in as this user (created and bootstrapped on first use); the desk gets a "switch user" menu. Ignored when `NODE_ENV=production`.            |
| `DEV_DEMO_TEAM`                            | API                    | `true`                               | With `DEV_USER_EMAIL`: seed Sam (supervisor), Alice, Bob and Carol (agents) into the dev user's contact center so the desk can be used as a team. `false` disables it.        |
| `API_PORT`                                 | Web (Vite)             | `4000`                               | Target port of the Vite `/api` proxy. Set it together with `PORT` when the API cannot use 4000.                                                                               |
| `WEB_PORT`                                 | Web (Vite)             | `3000`                               | Port of the web desk dev server.                                                                                                                                              |

`DATABASE_URL_TEST` is an optional override used only by the API integration tests (`apps/api/src/testing.ts`).

## Start Postgres

```console
docker compose up -d
```

This starts `postgres:17-alpine` on `localhost:5432` with user, password and database all set to `cc`, matching the default `DATABASE_URL`. The API applies the SQL migrations in `apps/api/drizzle` every time it boots, so there is no separate migrate step (run `node apps/api/src/db/migrate.ts` if you want to apply them by hand).

## Google OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create an OAuth 2.0 client of type **Web application**.
2. Add the authorized redirect URI `http://localhost:3000/api/auth/callback/google`. The redirect goes to the **web** origin because the Vite dev server proxies `/api` to the API; that keeps the session cookie first-party.
3. Put the client id and secret in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, set `ADMIN_EMAILS` to your Google account and a random `BETTER_AUTH_SECRET`.

No client yet? Set `DEV_USER_EMAIL=you@example.com` (and the same address in `ADMIN_EMAILS`) and every request is signed in as that user. The API logs a warning when the bypass is active.

### Being several people at once (dev only)

With the bypass on, the API seeds a **demo team** into your contact center — Sam (supervisor), Alice, Bob and Carol (agents, members of the `support` queue; Alice and Bob also of `sales`) — and the desk's app bar shows **Signed in as …**. Pick anyone from the menu (or "Other email…" for a new person, created on the spot) and the desk reloads as them. The choice lives in the tab's `sessionStorage` and travels as the `x-dev-user` header, so it is **one identity per browser tab**: to have a supervisor and an agent online at the same time, hover Alice in the menu and press **Open in new tab** (or open `http://localhost:3000/#/?as=alice@patchbay.dev` yourself), set both Available, and watch the ring move between them. A tab opened any other way starts as the default dev user; "Back to …" in the menu returns there. Set `DEV_DEMO_TEAM=false` to skip the seeding. The end-to-end suite plays several people the same way, plus a `cc_dev_user` cookie per browser context.

## Run the four dev servers

`npm run dev` starts all four at once (via `concurrently`, color-coded: api blue, web magenta, agent green, embed yellow; Ctrl+C stops them all). Or run each in its own terminal, from the repo root:

| Command             | What                                                             | URL                     |
| ------------------- | ---------------------------------------------------------------- | ----------------------- |
| `npm run dev:api`   | Fastify API with `node --watch`; runs migrations first           | `http://localhost:4000` |
| `npm run dev:web`   | Vite dev server for the desk, proxies `/api` (REST + ws) to 4000 | `http://localhost:3000` |
| `npm run dev:agent` | Agent worker, registers as `cc-agent` with LiveKit Cloud         | —                       |
| `npm run dev:embed` | Demo page with the call button                                   | `http://localhost:3001` |

`curl http://localhost:4000/api/health` should answer `{"ok":true}`. The agent terminal prints `registered worker` once LiveKit Cloud accepted it.

To talk to the agent from the terminal without the rest of the stack: `npm run -w apps/agent console`.

## First login and tenant bootstrap

Open `http://localhost:3000` and sign in with Google (or just load the page with `DEV_USER_EMAIL` set). On the first sign-in `bootstrapUser` in `apps/api/src/services/tenants.ts` runs:

- pending invites for your email become memberships;
- if you have no membership yet and your email is in `ADMIN_EMAILS`, a tenant named `<your name>'s contact center` is created with a default `support` queue and you become its **supervisor**.

Supervisors see the **Dashboard** and **Settings** tabs in addition to **Desk** and **History**. Anyone else needs an invite (Settings → members) before they can use the desk.

## Create an embed key

In **Settings → Call button for your website**, enter a label and press **Create key**. The API returns a public key (`pk_…`); the page shows the snippet to paste into a website:

```html
<script src="http://localhost:4000/embed/call-button.js"></script>
<cc-call-button
  key="pk_…"
  queue="support"
  api="http://localhost:4000"
  label="Call us"
></cc-call-button>
```

The `/embed/call-button.js` route exists only after `npm run build -w apps/embed` produced `apps/embed/dist`; during development use the demo page instead. An empty allowed-origins list means any origin may use the key.

## Make the first call

1. Go to the desk (`#/desk`) and press **Available** — this sends your presence over the websocket. Make sure you are a member of the `support` queue (Settings → queues), otherwise escalations never ring you.
2. Open `http://localhost:3001/?key=pk_…` (the demo page reads `key`, `api` and `queue` from the query string) and press **Call us**. Allow the microphone.
3. With the tenant in its default `ai-first` mode, LiveKit Cloud dispatches the agent and the button shows `AI assistant · 0:05`. Talk to it; ask for "a real person" to trigger `escalateToHuman`.
4. The desk shows a ring dialog with the reason and summary; **Accept** joins you to the same room. The AI leaves (default) and keeps transcribing.
5. Hang up on either side. **History** lists the call as `Ended` with its transcript, events and AI summary.

The ring you hear on the desk, the music the customer hears on hold and the optional ringback while they wait are configurable in **Settings → Sounds**: paste a public URL or upload a file (hold music must be a WAV; the media worker decodes it, everything else plays in the browser). Leave a field empty to keep the built-in sound. A queue can override the hold music in **Settings → Queues**.

## Troubleshooting

**The desk shows the Google button even though `DEV_USER_EMAIL` is set, and the browser console logs 502s for `/api/auth/get-session`.** The Vite proxy cannot reach the API — almost always because the API failed to start. Look for `Port 4000 is already in use` in the `[api]` output of `npm run dev` (with `node --watch` the crashed process stays alive, so the other apps keep running).

**Port 4000 is already in use (for example by NoMachine's `nxd.exe`).** Start the API on another port and point the Vite proxy at it: set `PORT=4100` and `API_PORT=4100` in `.env.local` (the agent also needs `API_ORIGIN=http://localhost:4100`). Alternatively change NoMachine's port.

**The customer connects but the AI never joins.** Check, in order:

- the agent terminal shows `registered worker` (the worker must be online before the call is created; dispatch happens when the customer's token creates the room);
- `INTERNAL_API_SECRET` is identical for the API and the agent — the worker logs `api /participants -> 401` otherwise;
- `API_ORIGIN` points at the running API;
- the tenant is in `ai-first` mode (in `human-first` mode the AI only joins after `humanFirstTimeoutSec` with nobody accepting).

**`Cannot find module` / bootloader errors when running Node from a VS Code terminal.** VS Code's JavaScript debugger injects `NODE_OPTIONS=--require …/bootloader.js`. Run `unset NODE_OPTIONS` (bash) or `$env:NODE_OPTIONS=''` (PowerShell) before `node` / `npm` commands, or disable auto-attach.

**`INTERNAL_API_SECRET is not set` / `LIVEKIT_URL/API_KEY/API_SECRET are not set` at API start.** The API fails fast on missing configuration; fill the variables in `.env.local`.

**Sign-in redirects to a 404.** The Google redirect URI must be on the web origin (`http://localhost:3000/api/auth/callback/google`), not the API port.
