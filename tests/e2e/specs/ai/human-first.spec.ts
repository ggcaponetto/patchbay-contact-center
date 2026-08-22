/**
 * Human-first routing: the call rings the humans before any AI is involved; when nobody
 * answers, the API dispatches the agent worker as a fallback and the customer gets the
 * AI. Needs `LIVEKIT_*` (the fallback is a real dispatch).
 */
import { HAS_CLOUD } from '../../../../playwright.config.ts';
import { DeskPage, EmbedButton, admin, desk, expect, test } from '../../support/fixtures.ts';

test.skip(!HAS_CLOUD, 'needs LiveKit Cloud credentials');

test.afterEach(async ({ supervisor }) => {
  await admin(supervisor.request).updateSettings({ routingMode: 'ai-first', offerTimeoutSec: 20 });
});

test(
  'human-first rings the desk first and falls back to the AI when nobody answers',
  { tag: ['@cloud', '@ai', '@desk', '@E2E-29'] },
  async ({ page, context, supervisor, tenant }) => {
    await admin(supervisor.request).updateSettings({
      routingMode: 'human-first',
      offerTimeoutSec: 5,
      humanFirstTimeoutSec: 5,
    });
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await deskPage.setReady();

    const button = new EmbedButton(await context.newPage());
    await button.goto(tenant.key);
    await button.call();
    // rung before any AI exists; let it time out
    await deskPage.expectRinging();
    await expect(button.element).toContainText('Please hold');
    await expect(deskPage.dialog).toHaveCount(0, { timeout: 15_000 });
    await expect(button.element).toContainText('AI assistant', { timeout: 60_000 });

    const [callRow] = await desk(supervisor.request).calls();
    const detail = await desk(supervisor.request).call(callRow!.id);
    expect(detail.status).toBe('ai');
    expect(detail.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['offer.nobody', 'ai.joined']),
    );
  },
);
