/**
 * Entry point of the AI agent worker process.
 *
 * Registers with LiveKit Cloud under the agent name `cc-agent` and runs
 * {@link createEntry} once per job (one call). All job logic lives in `worker.ts`; this
 * file only loads the environment, defines the agent and starts the CLI
 * (`dev` / `start` / `console` sub-commands come from the command line argument).
 *
 * Importing this module starts the worker (`cli.runApp`), so `main.test.ts` stubs that
 * one call and only checks the wiring; the job logic itself is tested in `worker.test.ts`.
 *
 * Run with `npm run dev:agent` (hot reload) or `npm run -w apps/agent console` (local
 * microphone, no LiveKit room).
 *
 * @see apps/agent/README.md for the lifecycle and handoff diagrams.
 * @packageDocumentation
 */
import { ServerOptions, cli, defineAgent } from '@livekit/agents';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { AGENT_NAME, createEntry } from './worker.ts';

// Works from the workspace folder and from the repository root.
dotenv.config({ path: ['.env.local', '../../.env.local'] });

/** The agent definition loaded by the LiveKit worker; `entry` runs once per job. */
export default defineAgent({ entry: createEntry() });

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
