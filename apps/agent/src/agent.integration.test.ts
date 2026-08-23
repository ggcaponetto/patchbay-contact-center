/**
 * Behavioral evals of the contact-center agent (LLM-as-judge).
 *
 * Each test drives the agent through a text-only `voice.AgentSession` with
 * `session.run({ userInput })`, then asserts on the produced events: tool calls are
 * checked exactly, while the wording of replies is graded by a judge LLM against an
 * `intent`. The tool side effects are `vi.fn` stubs, so no API or LiveKit room is needed.
 *
 * Requires LiveKit Cloud credentials (`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`) for
 * LiveKit Inference; the whole suite skips itself when they are missing. Runs under the
 * `integration` vitest project (`npm run test:integration`).
 *
 * @see apps/agent/README.md (section "Evals") for how to add a new test.
 */
import { inference, initializeLogger, voice } from '@livekit/agents';
import dotenv from 'dotenv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentActions, LLM_MODEL, createAgent, summarize } from './agent.ts';

dotenv.config({ path: ['.env.local', '../../.env.local'] });

// The evals talk to LiveKit Inference; without Cloud credentials (e.g. CI
// without secrets) they skip instead of failing.
const hasCloud = Boolean(process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);

initializeLogger({ pretty: true, level: 'warn' });

describe.skipIf(!hasCloud)('contact center agent', () => {
  let session: voice.AgentSession;
  let judgeLlm: inference.LLM;
  let actions: { [K in keyof AgentActions]: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    judgeLlm = new inference.LLM({ model: 'openai/gpt-4.1-mini' });
    actions = {
      escalate: vi.fn(async () => 'Tell the caller you are connecting them to a colleague.'),
      endCall: vi.fn(async () => undefined),
    };
    session = new voice.AgentSession();
    await session.start({
      agent: createAgent({ instructions: 'The company is Acme Bikes.', actions }),
    });
  });

  afterEach(async () => {
    await session?.close();
    await judgeLlm?.aclose();
  });

  it('greets and offers assistance', { timeout: 30000 }, async () => {
    const result = await session.run({ userInput: 'Hello' }).wait();
    await result.expect
      .nextEvent()
      .isMessage({ role: 'assistant' })
      .judge(judgeLlm, { intent: 'Greets the caller in a friendly manner and offers help.' });
    result.expect.noMoreEvents();
    expect(actions.escalate).not.toHaveBeenCalled();
  });

  it('escalates when the caller asks for a human', { timeout: 45000 }, async () => {
    const result = await session
      .run({ userInput: 'I want to talk to a real person about my broken bike, not a bot.' })
      .wait();
    result.expect.containsFunctionCall({ name: 'escalateToHuman' });
    expect(actions.escalate).toHaveBeenCalledTimes(1);
    const args = actions.escalate.mock.calls[0]![0] as { reason: string; summary: string };
    expect(args.reason.length).toBeGreaterThan(3);
    expect(args.summary.length).toBeGreaterThan(10);
    await result.expect.containsMessage({ role: 'assistant' }).judge(judgeLlm, {
      intent: 'Tells the caller they are being connected to a colleague or human agent.',
    });
  });

  it('hangs up after a goodbye', { timeout: 45000 }, async () => {
    const result = await session.run({ userInput: "That's all I needed, thanks, goodbye!" }).wait();
    result.expect.containsFunctionCall({ name: 'endCall' });
    expect(actions.endCall).toHaveBeenCalledTimes(1);
  });

  it('summarizes a conversation', { timeout: 30000 }, async () => {
    const text = await summarize(new inference.LLM({ model: LLM_MODEL }), session.history);
    expect(text).toBe('');
    await session.run({ userInput: 'Hi, my order 1234 never arrived.' }).wait();
    const summary = await summarize(new inference.LLM({ model: LLM_MODEL }), session.history);
    expect(summary.toLowerCase()).toMatch(/order|arrive|arrived|deliver/);
  });

  describe('routing tags', () => {
    const skills = [
      {
        key: 'mechanical-engineering',
        label: 'Mechanical engineering',
        description: 'Gearboxes, drive trains, brakes and other mechanical faults',
      },
      { key: 'billing', label: 'Billing', description: 'Invoices, payments and refunds' },
    ];
    let tagged: voice.AgentSession;
    beforeEach(async () => {
      tagged = new voice.AgentSession();
      await tagged.start({
        agent: createAgent({ instructions: 'The company is Acme Bikes.', skills, actions }),
      });
    });
    afterEach(() => tagged?.close());

    it('tags the escalation with the matching skill', { timeout: 45000 }, async () => {
      const result = await tagged
        .run({
          userInput:
            'My gearbox is grinding in third gear and I already tried adjusting it. Please let me talk to a person.',
        })
        .wait();
      result.expect.containsFunctionCall({ name: 'escalateToHuman' });
      const args = actions.escalate.mock.calls[0]![0] as { skills?: string[] };
      expect(args.skills).toContain('mechanical-engineering');
      expect(args.skills).not.toContain('billing');
    });

    it('reports the language the caller asks for', { timeout: 45000 }, async () => {
      const result = await tagged
        .run({
          userInput:
            'I only speak Italian, my English is bad. Can I talk to a person in Italian please?',
        })
        .wait();
      result.expect.containsFunctionCall({ name: 'escalateToHuman' });
      const args = actions.escalate.mock.calls[0]![0] as { language?: string };
      expect(args.language?.toLowerCase()).toBe('it');
    });
  });
});
