/**
 * Unit tests for `agent.ts`: prompt assembly, the two tools' `execute` functions (called
 * directly through the agent's tool context, no LLM involved) and `summarize` with a fake
 * LLM. No network or LiveKit credentials are needed.
 */
import { llm } from '@livekit/agents';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { type AgentActions, LLM_MODEL, createAgent, summarize } from './agent.ts';

/** A `llm.LLM` stand-in whose `chat()` resolves to a fixed text; records the chat context. */
const fakeLlm = (text: string) => {
  const chat = vi.fn((opts: { chatCtx: llm.ChatContext }) => ({
    collect: async () => ({ text }),
    chatCtx: opts.chatCtx,
  }));
  return { llm: { chat } as unknown as llm.LLM, chat };
};

const actions = (): { [K in keyof AgentActions]: ReturnType<typeof vi.fn> } => ({
  escalate: vi.fn(async () => 'Tell the caller Sam is joining.'),
  endCall: vi.fn(async () => undefined),
});

/** Tool options the SDK passes to `execute`; the tools here ignore them. */
const toolOpts = {} as unknown as Parameters<llm.FunctionTool['execute']>[1];

describe('createAgent', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('appends tenant instructions under a heading and keeps the base prompt otherwise', () => {
    const withTenant = createAgent({
      instructions: 'The company is Acme Bikes.',
      actions: actions(),
      llm: fakeLlm('').llm,
    });
    expect(withTenant.instructions).toContain(
      '# Company instructions\n\nThe company is Acme Bikes.',
    );
    expect(withTenant.instructions).toContain('# Escalation');
    const plain = createAgent({ actions: actions(), llm: fakeLlm('').llm });
    expect(plain.instructions).not.toContain('# Company instructions');
    expect(plain.instructions).toContain('# Escalation');
    expect(plain.instructions).not.toContain('# Routing skills');
  });

  it('lists the routing skill catalogue and offers it as the skills enum', () => {
    const skills = [
      { key: 'billing', label: 'Billing', description: 'Invoices and refunds' },
      { key: 'mechanical-engineering', label: 'Mechanical engineering', description: '' },
    ];
    const agent = createAgent({
      skills,
      language: 'de-CH',
      actions: actions(),
      llm: fakeLlm('').llm,
    });
    expect(agent.instructions).toContain(
      [
        '# Routing skills',
        '',
        '- billing — Billing: Invoices and refunds',
        '- mechanical-engineering — Mechanical engineering',
        '',
      ].join('\n'),
    );
    expect(agent.instructions).toContain("caller's language as de-CH");
    const params = agent.toolCtx.functionTools['escalateToHuman']!.parameters as z.ZodObject<
      Record<string, z.ZodTypeAny>
    >;
    expect(params.safeParse({ reason: 'r', summary: 's', skills: ['billing'] }).success).toBe(true);
    expect(params.safeParse({ reason: 'r', summary: 's', skills: ['nope'] }).success).toBe(false);
    // without a catalogue there is no `skills` parameter at all, but `language` stays
    const bare = createAgent({ actions: actions(), llm: fakeLlm('').llm });
    const bareParams = bare.toolCtx.functionTools['escalateToHuman']!.parameters as z.ZodObject<
      Record<string, z.ZodTypeAny>
    >;
    expect(Object.keys(bareParams.shape).sort()).toEqual(['language', 'reason', 'summary']);
  });

  it('builds the LiveKit Inference LLM by default', () => {
    // The constructor only needs credentials to exist; nothing is contacted.
    vi.stubEnv('LIVEKIT_API_KEY', 'key');
    vi.stubEnv('LIVEKIT_API_SECRET', 'secret');
    const agent = createAgent({ actions: actions() });
    expect((agent.llm as { model: string }).model).toBe(LLM_MODEL);
    expect(
      (createAgent({ actions: actions(), llmModel: 'x/y' }).llm as { model: string }).model,
    ).toBe('x/y');
  });

  it('exposes escalateToHuman and endCall tools that delegate to the actions', async () => {
    const acts = actions();
    const agent = createAgent({ actions: acts, llm: fakeLlm('').llm });
    const tools = agent.toolCtx.functionTools;
    expect(Object.keys(tools).sort()).toEqual(['endCall', 'escalateToHuman']);

    const escalate = tools['escalateToHuman']!;
    await expect(
      escalate.execute({ reason: 'wants a human', summary: 'Bike broke.' }, toolOpts),
    ).resolves.toBe('Tell the caller Sam is joining.');
    expect(acts.escalate).toHaveBeenCalledWith({ reason: 'wants a human', summary: 'Bike broke.' });
    await escalate.execute({ reason: 'r', summary: 's', language: 'it' }, toolOpts);
    expect(acts.escalate).toHaveBeenLastCalledWith({ reason: 'r', summary: 's', language: 'it' });

    const endCall = tools['endCall']!;
    await expect(endCall.execute({}, toolOpts)).resolves.toMatch(/goodbye/i);
    expect(acts.endCall).toHaveBeenCalledTimes(1);
  });
});

describe('summarize', () => {
  it('returns an empty string without asking the LLM when there are no messages', async () => {
    const { llm: model, chat } = fakeLlm('unused');
    const history = llm.ChatContext.empty();
    history.addMessage({ role: 'system', content: 'You are helpful.' });
    history.insert(llm.FunctionCall.create({ callId: 'c1', name: 'endCall', args: '{}' }));
    await expect(summarize(model, history)).resolves.toBe('');
    expect(chat).not.toHaveBeenCalled();
  });

  it('renders user and assistant turns as Caller/Agent lines and trims the reply', async () => {
    const { llm: model, chat } = fakeLlm('  The caller asked about a bike.  ');
    const history = llm.ChatContext.empty();
    history.addMessage({ role: 'system', content: 'ignored' });
    history.addMessage({ role: 'user', content: 'My bike is broken.' });
    history.insert(llm.FunctionCall.create({ callId: 'c1', name: 'escalateToHuman', args: '{}' }));
    history.addMessage({ role: 'assistant', content: 'I am sorry to hear that.' });
    history.addMessage({ role: 'developer', content: 'also ignored' });
    history.addMessage({ role: 'user', content: [] }); // no text parts -> empty line
    await expect(summarize(model, history)).resolves.toBe('The caller asked about a bike.');
    expect(chat).toHaveBeenCalledTimes(1);
    const sent = chat.mock.calls[0]![0].chatCtx.items.filter(
      (i): i is llm.ChatMessage => i instanceof llm.ChatMessage,
    );
    expect(sent[0]!.role).toBe('system');
    expect(sent[1]!.textContent).toBe(
      'Caller: My bike is broken.\nAgent: I am sorry to hear that.\nCaller: ',
    );
  });
});
