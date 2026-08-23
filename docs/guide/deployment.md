# Deployment

The POC has four deployable pieces: the agent worker (LiveKit Cloud), the API (any Node host with Postgres), the web desk (static files) and the embed script (served by the API). Nothing in the repo automates hosting beyond the Dockerfile and the docs workflow; what follows is what the code expects.

## Agent worker → LiveKit Cloud

The root `Dockerfile` builds only `apps/agent` (plus `packages/shared`) for [LiveKit Cloud agent deployment](https://docs.livekit.io/deploy/agents/): `npm ci --workspace apps/agent`, `npx livekit-agents download-files` to pre-fetch plugin models, then `npm start` (`node src/main.ts start`) as a non-root user with `NODE_ENV=production`.

```console
lk cloud auth
lk agent create          # first time: registers the agent and writes livekit.toml
lk agent deploy          # every later release
```

Environment to set on the Cloud agent with `--secrets KEY=VALUE` (or `--secrets-file`) on `lk agent create` / `lk agent deploy`, or through the Cloud dashboard ([secrets management](https://docs.livekit.io/deploy/agents/secrets/)):

| Variable              | Value                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_ORIGIN`          | The **public** URL of your API, e.g. `https://api.example.com`. The worker posts transcripts, events and the escalation long-poll there; `localhost` will not work from the Cloud. |
| `INTERNAL_API_SECRET` | The same value the API uses; it goes into the `x-internal-secret` header.                                                                                                          |

`LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` are injected by LiveKit Cloud for deployed agents; do not set them yourself. The worker registers under the name `cc-agent`; the API dispatches exactly that name, so keep it unless you change `AGENT_NAME` in both `apps/api/src/livekit.ts` and `apps/agent/src/main.ts`. Commit `livekit.toml` once it exists.

Until the agent is deployed, a laptop running `npm run dev:agent` with the same `API_ORIGIN` serves the same purpose (`TODO.md`).

## API

Requirements: Node 24, a Postgres database, and the environment described in [Getting started](/docs/guide/getting-started). Start it with `npm ci` at the repo root and `npm run -w apps/api start` (`node src/index.ts`), or build your own image along the lines of the agent Dockerfile. There is no compile step.

- **Migrations** run at boot: `runMigrations()` applies `apps/api/drizzle/*` before the server listens. Point `DATABASE_URL` at the production database; the API fails fast if it is unset.
- Set `PORT`, `WEB_ORIGIN` (the public desk origin, used as Better Auth `baseURL` and trusted origin), `INTERNAL_API_SECRET`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `ADMIN_EMAILS` and the three `LIVEKIT_*` values.
- Set **`NODE_ENV=production`**. Besides the usual Fastify logging defaults, this is what disables the dev auth bypass: `apps/api/src/index.ts` only honours `DEV_USER_EMAIL` when `NODE_ENV !== 'production'`. **Never set `DEV_USER_EMAIL` in production** — it signs every request in as that user and makes them a supervisor if they are in `ADMIN_EMAILS`.
- The server binds `0.0.0.0` and needs websocket pass-through on `/api/ws` from whatever proxy sits in front of it.

## Web desk

```console
npm run build -w apps/web        # apps/web/dist
```

Host the `dist` folder on any static host. Two constraints come from how the desk talks to the API:

1. **Same origin for `/api`.** The client fetches `/api/...` and opens `wss://<host>/api/ws` relative to its own origin (`apps/web/src/lib/hooks.ts`), and the Better Auth session cookie is first-party to that origin. In production the host (or a reverse proxy) must forward `/api/*` — including websockets — to the API, exactly as the Vite dev proxy does. Alternatively serve the built desk from the same domain as the API.
2. **`WEB_ORIGIN` on the API must match** the public desk URL, or Better Auth rejects the OAuth callback.

## Embed script

```console
npm run build -w apps/embed      # apps/embed/dist/call-button.js
```

`apps/api/src/server.ts` registers `@fastify/static` on `/embed/` only when `apps/embed/dist` exists at boot, so build the embed before starting the API (in a container, copy the `dist` folder next to the API). Websites then load `https://api.example.com/embed/call-button.js` and use `<cc-call-button key="pk_…" queue="support">`; the button derives the API origin from the script URL, or from an explicit `api` attribute. Restrict each embed key to the sites that may use it via **allowed origins** in Settings (an empty list allows every origin).

## Google OAuth in production

Add a second authorized redirect URI to the OAuth client: `https://<desk host>/api/auth/callback/google` — again on the desk origin, since `/api` is proxied. Keep the `localhost:3000` URI for development.

## Docs site

`.github/workflows/docs.yml` builds the VitePress site (`npm run docs:build`, which first runs typedoc) and deploys `.vitepress/dist` to GitHub Pages on every push to `main` that touches `docs/**`, `packages/shared/**`, `typedoc.json` or the workflow itself. The site's `base` is `/patchbay-contact-center/`. Enable **Pages → Source: GitHub Actions** in the repository settings once.
