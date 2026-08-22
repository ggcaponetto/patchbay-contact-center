/**
 * Smoke test for the process entry point: `cli.runApp` is stubbed so importing `main.ts`
 * does not start a worker, then the agent definition and server options are checked.
 */
import { ServerOptions, cli } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@livekit/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@livekit/agents')>();
  return { ...actual, cli: { ...actual.cli, runApp: vi.fn() } };
});
// Not needed by this test and loads a native binding at import time.
vi.mock('@livekit/plugins-ai-coustics', () => ({ EnhancerModel: {}, audioEnhancement: vi.fn() }));

describe('main', () => {
  it('defines the agent and starts the CLI under the cc-agent name', async () => {
    const mod = await import('./main.ts');
    expect(typeof mod.default.entry).toBe('function');
    expect(cli.runApp).toHaveBeenCalledTimes(1);
    const opts = (cli.runApp as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ServerOptions;
    expect(opts).toBeInstanceOf(ServerOptions);
    expect(opts.agentName).toBe('cc-agent');
    expect(opts.agent).toMatch(/main\.ts$/);
  });
});
