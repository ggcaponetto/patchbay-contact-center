/**
 * Process entrypoint of the MCP server (`npm run -w apps/mcp start`): fetches the
 * API's OpenAPI document, builds the tools and handlers (`server.ts`) and serves them
 * over stdio, so any MCP client (Claude, an IDE, another agent) can operate the
 * contact center with an API key. Nothing else lives here, so the logic stays testable.
 *
 * Env: `MCP_API_URL` (default `http://localhost:4000`) and `MCP_API_KEY` (an `ak_…`
 * key from Settings → API keys; its permissions bound what the tools may do).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { type Spec, buildTools, config, handlers } from './server.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'], quiet: true });

const cfg = config(process.env);
if ('error' in cfg) {
  console.error(cfg.error);
  process.exit(1);
}

const spec = (await (await fetch(`${cfg.apiUrl}/api/openapi.json`)).json()) as Spec;
const tools = buildTools(spec);
const handle = handlers(tools, { ...cfg, fetch });

const server = new Server(
  { name: 'patchbay-contact-center', version: '0.1.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, handle.list);
server.setRequestHandler(CallToolRequestSchema, (request) =>
  handle.call(request.params.name, request.params.arguments as Record<string, unknown>),
);

await server.connect(new StdioServerTransport());
console.error(`mcp: serving ${tools.length} tools for ${cfg.apiUrl}`);
