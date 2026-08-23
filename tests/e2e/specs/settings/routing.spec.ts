/**
 * Routing settings: who answers first, what the AI does on handoff, the timeouts and the
 * AI prompt — saved, persisted across a reload, and validated.
 */
import { SettingsPage, admin, expect, test } from '../../support/fixtures.ts';

test(
  'routing settings are saved, survive a reload and reject out-of-range values',
  { tag: ['@core', '@settings', '@E2E-20'] },
  async ({ page, supervisor }) => {
    const settings = new SettingsPage(page);
    await settings.goto();
    await settings.selectOption('Who answers first', 'Ring humans first, AI as fallback');
    await settings.selectOption(
      'When a human takes over, the AI',
      'stays muted and keeps listening',
    );
    await page.getByLabel('Ring each agent for (s)').fill('15');
    await page.getByLabel('Human-first timeout (s)').fill('45');
    await page.getByLabel('AI greeting instruction').fill('Welcome the caller to Acme Bikes.');
    await page.getByLabel('Company instructions for the AI').fill('We sell bikes. Open 9-17.');
    await settings.save();
    await expect
      .poll(async () => (await admin(supervisor.request).tenant()).settings)
      .toMatchObject({
        routingMode: 'human-first',
        handoff: { aiBehavior: 'listen' },
        offerTimeoutSec: 15,
        humanFirstTimeoutSec: 45,
        aiAgent: {
          greeting: 'Welcome the caller to Acme Bikes.',
          instructions: 'We sell bikes. Open 9-17.',
        },
      });

    await page.reload();
    await expect(page.getByLabel('Who answers first')).toHaveText(
      'Ring humans first, AI as fallback',
    );
    await expect(page.getByLabel('Ring each agent for (s)')).toHaveValue('15');
    await expect(page.getByLabel('Company instructions for the AI')).toHaveValue(
      'We sell bikes. Open 9-17.',
    );

    await page.getByLabel('Ring each agent for (s)').fill('1');
    await settings.save();
    await expect(settings.toast).toContainText('The request was not valid');
    expect((await admin(supervisor.request).tenant()).settings.offerTimeoutSec).toBe(15);

    // leave the tenant as the other specs expect it
    await admin(supervisor.request).updateSettings({
      routingMode: 'ai-first',
      handoff: { aiBehavior: 'leave' },
      offerTimeoutSec: 20,
      humanFirstTimeoutSec: 30,
    });
  },
);
