/**
 * The heart of the MCP server: turns the API's OpenAPI document into MCP tools and
 * executes tool calls as HTTP requests with an API key. "Tools = routes": every
 * permission-gated operation (desk and admin) becomes one tool, named after its method
 * and path; what the key may actually do is decided by the API per request, so the
 * tool list is the same for every key while calls beyond its permissions answer 403.
 *
 * Pure functions over the fetched spec — the MCP SDK wiring lives in `index.ts`.
 *
 * @see apps/mcp/README.md
 * @packageDocumentation
 */

/** The slice of an OpenAPI operation this server reads. */
type Operation = {
  summary?: string;
  description?: string;
  'x-permission'?: string;
  parameters?: { name: string; in: string }[];
  requestBody?: { content?: { 'application/json'?: { schema?: JsonSchema } } };
};

/** A JSON-schema object as zod's `toJSONSchema` emits it. */
type JsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

/** The slice of the OpenAPI document this server reads. */
export type Spec = { paths: Record<string, Record<string, Operation>> };

/** One generated tool: what MCP lists, plus how to execute it. */
export type Tool = {
  /** MCP tool name, e.g. `get_desk_calls` or `post_desk_calls_id_recording`. */
  name: string;
  description: string;
  /** Flat JSON schema: path parameters and body properties side by side. */
  inputSchema: JsonSchema;
  /** HTTP method (upper case) and the `/api/...` path with `{param}` placeholders. */
  method: string;
  path: string;
  /** Names of the path parameters (everything else in the input is the body). */
  params: string[];
};

/** Access values that are not permissions: their routes never become tools. */
const NON_TOOL_ACCESS = new Set(['public', 'internal', 'session', 'admin-email', undefined]);

/** `POST /api/desk/calls/{id}/recording` → `post_desk_calls_id_recording`. */
const toolName = (method: string, path: string): string =>
  `${method.toLowerCase()}_${path
    .replace(/^\/api\//, '')
    .replaceAll(/[{}]/g, '')
    .replaceAll('/', '_')}`;

/**
 * Builds the tool list from the OpenAPI document: one tool per permission-gated
 * operation, with the path parameters and the request-body properties merged into one
 * flat input schema (path parameters win on a name collision).
 */
export function buildTools(spec: Spec): Tool[] {
  const tools: Tool[] = [];
  for (const [path, ops] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (NON_TOOL_ACCESS.has(op['x-permission'])) continue;
      const params = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name);
      const body = op.requestBody?.content?.['application/json']?.schema;
      tools.push({
        name: toolName(method, path),
        description: `${op.summary ?? ''} [${method.toUpperCase()} ${path}, needs ${op['x-permission']}]`,
        inputSchema: {
          type: 'object',
          properties: {
            ...(body?.properties ?? {}),
            ...Object.fromEntries(params.map((p) => [p, { type: 'string' }])),
          },
          required: [...(body?.required ?? []).filter((r) => !params.includes(r)), ...params],
        },
        method: method.toUpperCase(),
        path,
        params,
      });
    }
  }
  return tools;
}

/**
 * Reads the server's configuration from the environment. The URL defaults to the dev
 * API; the key is mandatory (`error` tells the entrypoint to refuse to start).
 */
export function config(
  env: Record<string, string | undefined>,
): { apiUrl: string; apiKey: string } | { error: string } {
  const apiKey = env['MCP_API_KEY'] ?? '';
  if (apiKey === '') return { error: 'MCP_API_KEY is not set (create one in Settings → API keys)' };
  return { apiUrl: env['MCP_API_URL'] ?? 'http://localhost:4000', apiKey };
}

/** What {@link callTool} needs: the API origin, the key, and a `fetch` (injectable). */
export type CallDeps = {
  apiUrl: string;
  apiKey: string;
  fetch: typeof globalThis.fetch;
};

/**
 * The two MCP request handlers, prebuilt so `index.ts` is pure wiring: `list` answers
 * `tools/list`, `call` answers `tools/call` (including the unknown-tool error).
 */
export function handlers(tools: Tool[], deps: CallDeps) {
  return {
    async list() {
      return {
        tools: tools.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      };
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return { content: [{ type: 'text' as const, text: 'unknown tool' }], isError: true };
      }
      const { text, isError } = await callTool(deps, tool, args);
      return { content: [{ type: 'text' as const, text }], isError };
    },
  };
}

/**
 * Executes one tool call: substitutes the path parameters, sends everything else as
 * the JSON body (for non-GET methods), authenticates with the API key, and returns the
 * response body as text plus an error flag on non-2xx answers.
 */
export async function callTool(
  deps: CallDeps,
  tool: Tool,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  let path = tool.path;
  for (const p of tool.params) path = path.replace(`{${p}}`, encodeURIComponent(String(args[p])));
  const body = Object.fromEntries(
    Object.entries(args).filter(([key]) => !tool.params.includes(key)),
  );
  const res = await deps.fetch(`${deps.apiUrl}${path}`, {
    method: tool.method,
    headers: {
      authorization: `Bearer ${deps.apiKey}`,
      'content-type': 'application/json',
    },
    ...(tool.method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  return { text: await res.text(), isError: !res.ok };
}
