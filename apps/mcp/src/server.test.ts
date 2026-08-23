import { describe, expect, it, vi } from 'vitest';
import { type Spec, buildTools, callTool, config, handlers } from './server.ts';

const spec: Spec = {
  paths: {
    '/api/openapi.json': { get: { summary: 'This document', 'x-permission': 'public' } },
    '/api/me': { get: { summary: 'Who am I', 'x-permission': 'session' } },
    '/api/internal/calls/{id}/escalate': {
      post: { summary: 'Escalate', 'x-permission': 'internal' },
    },
    '/api/desk/calls': { get: { summary: 'List calls', 'x-permission': 'calls:read' } },
    '/api/desk/calls/{id}/recording': {
      post: {
        summary: 'Control call recording',
        'x-permission': 'calls:answer',
        parameters: [{ name: 'id', in: 'path' }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { action: { type: 'string', enum: ['start', 'stop'] } },
                required: ['action'],
              },
            },
          },
        },
      },
    },
  },
};

describe('buildTools', () => {
  it('creates one tool per permission-gated operation with a flat input schema', () => {
    const tools = buildTools(spec);
    expect(tools.map((t) => t.name)).toEqual(['get_desk_calls', 'post_desk_calls_id_recording']);
    const recording = tools[1]!;
    expect(recording.description).toContain('Control call recording');
    expect(recording.description).toContain('needs calls:answer');
    expect(recording.inputSchema).toEqual({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop'] },
        id: { type: 'string' },
      },
      required: ['action', 'id'],
    });
    expect(recording.params).toEqual(['id']);
  });
});

describe('callTool', () => {
  const deps = (ok: boolean, text = '{"ok":true}') => {
    const fetch = vi.fn(async () => ({ ok, text: async () => text }) as Response);
    return { deps: { apiUrl: 'http://api:4000', apiKey: 'ak_1', fetch }, fetch };
  };

  it('substitutes path params, sends the rest as the body, and authenticates', async () => {
    const tools = buildTools(spec);
    const { deps: d, fetch } = deps(true);
    const result = await callTool(d, tools[1]!, { id: 'c 1', action: 'start' });
    expect(result).toEqual({ text: '{"ok":true}', isError: false });
    expect(fetch).toHaveBeenCalledWith('http://api:4000/api/desk/calls/c%201/recording', {
      method: 'POST',
      headers: { authorization: 'Bearer ak_1', 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    });
  });

  it('sends GET without a body and flags non-2xx answers as errors', async () => {
    const tools = buildTools(spec);
    const { deps: d, fetch } = deps(false, '{"error":"forbidden"}');
    const result = await callTool(d, tools[0]!, {});
    expect(result).toEqual({ text: '{"error":"forbidden"}', isError: true });
    const init = fetch.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('GET');
    expect('body' in init).toBe(false);
  });
});

describe('handlers', () => {
  it('lists the tools and dispatches calls, refusing unknown names', async () => {
    const fetch = vi.fn(async () => ({ ok: true, text: async () => 'body' }) as Response);
    const h = handlers(buildTools(spec), { apiUrl: 'http://x', apiKey: 'ak_1', fetch });
    const listed = await h.list();
    expect(listed.tools.map((t) => t.name)).toContain('get_desk_calls');
    expect(listed.tools[0]).not.toHaveProperty('method'); // only the MCP fields go out
    expect(await h.call('get_desk_calls', {})).toEqual({
      content: [{ type: 'text', text: 'body' }],
      isError: false,
    });
    expect(await h.call('nope', {})).toEqual({
      content: [{ type: 'text', text: 'unknown tool' }],
      isError: true,
    });
  });
});

describe('config', () => {
  it('requires the key and defaults the URL', () => {
    expect(config({})).toEqual({ error: expect.stringContaining('MCP_API_KEY') });
    expect(config({ MCP_API_KEY: 'ak_1' })).toEqual({
      apiUrl: 'http://localhost:4000',
      apiKey: 'ak_1',
    });
    expect(config({ MCP_API_KEY: 'ak_1', MCP_API_URL: 'https://cc.example' })).toEqual({
      apiUrl: 'https://cc.example',
      apiKey: 'ak_1',
    });
  });
});
