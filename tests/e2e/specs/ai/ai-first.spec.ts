/**
 * The real thing: the customer presses the embedded button, LiveKit Cloud dispatches the
 * agent worker (started by global-setup.ts), the AI joins and speaks, and the call ends
 * when the customer hangs up. Needs `LIVEKIT_*`; the fake microphone cannot talk, so the
 * AI only ever hears silence — what it says on its own (the greeting) is enough here.
 */
import { HAS_CLOUD } from '../../../../playwright.config.ts';
import { CallPage, EmbedButton, HistoryPage, desk, expect, test } from '../../support/fixtures.ts';

test.skip(!HAS_CLOUD, 'needs LiveKit Cloud credentials');

test(
  'the AI answers an embedded call and its greeting lands in the transcript',
  { tag: ['@cloud', '@ai', '@embed', '@E2E-26'] },
  async ({ context, supervisor, tenant }) => {
    // the customer is a second tab: navigating the supervisor's tab must not end the call
    const button = new EmbedButton(await context.newPage());
    await button.goto(tenant.key);
    await button.call();
    await expect(button.element).toContainText('AI assistant', { timeout: 45_000 });

    const [callRow] = await desk(supervisor.request).calls();
    const callPage = new CallPage(supervisor.page);
    await callPage.goto(callRow!.id);
    await expect(callPage.statusChip()).toHaveText('With AI');
    await expect(callPage.transcript().getByRole('listitem').first()).toContainText('ai', {
      timeout: 45_000,
    });
    const detail = await desk(supervisor.request).call(callRow!.id);
    expect(detail.events.map((e) => e.type)).toContain('ai.joined');
    expect(detail.participants.map((p) => p.kind)).toEqual(
      expect.arrayContaining(['customer', 'ai']),
    );
  },
);

test(
  'when the customer hangs up the AI leaves and the call is ended in history',
  { tag: ['@cloud', '@ai', '@embed', '@E2E-30'] },
  async ({ context, supervisor, tenant }) => {
    const button = new EmbedButton(await context.newPage());
    await button.goto(tenant.key);
    await button.call();
    await expect(button.element).toContainText('AI assistant', { timeout: 45_000 });
    const [callRow] = await desk(supervisor.request).calls();

    await button.hangUp();
    await expect(button.element).toContainText('Call ended');
    await expect
      .poll(async () => (await desk(supervisor.request).call(callRow!.id)).status, {
        timeout: 60_000,
      })
      .toBe('ended');
    const detail = await desk(supervisor.request).call(callRow!.id);
    expect(detail.participants.find((p) => p.kind === 'ai')?.leftAt).not.toBeNull();
    const history = new HistoryPage(supervisor.page);
    await history.goto();
    await expect(history.rows().first()).toContainText('Ended');
  },
);
