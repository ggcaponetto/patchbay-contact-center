/**
 * Supervisor-to-team messaging: a direct instant message to one agent, a broadcast to
 * every desk, and the persistent ticker banner (set and cleared from the dashboard).
 */
import { DeskPage, expect, test } from '../../support/fixtures.ts';

test(
  'direct message, broadcast and ticker reach the agent desk',
  { tag: ['@core', '@supervisor', '@E2E-47'] },
  async ({ page, queueAgent, unique }) => {
    const alice = await queueAgent(`${unique('alice')}@example.com`);
    const aliceDesk = new DeskPage(alice.page);
    await aliceDesk.goto();

    await page.goto('/#/dashboard');
    // direct message from the agent row's menu
    await page.getByRole('button', { name: `actions for ${alice.name}` }).click();
    await page.getByRole('menuitem', { name: 'Message…' }).click();
    await page.getByLabel(`Message ${alice.name}`).fill('Please wrap up soon');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(alice.page.getByText('Please wrap up soon')).toBeVisible();

    // broadcast reaches every desk, labeled as such
    await page.getByLabel('Broadcast to every desk').fill('Stand-up in 5');
    await page.getByRole('button', { name: 'Broadcast' }).click();
    await expect(alice.page.getByText('(to everyone):', { exact: false })).toBeVisible();
    await expect(alice.page.getByText('Stand-up in 5', { exact: false })).toBeVisible();

    // the ticker is a persistent banner on every desk, and clearing removes it
    await page
      .getByLabel('Ticker banner (empty clears it)')
      .fill('Phone system maintenance at 18:00');
    await page.getByRole('button', { name: 'Set ticker' }).click();
    await expect(alice.page.getByTestId('ticker')).toContainText('maintenance at 18:00');
    await expect(page.getByTestId('ticker')).toContainText('maintenance at 18:00');
    await page.getByLabel('Ticker banner (empty clears it)').fill('');
    await page.getByRole('button', { name: 'Set ticker' }).click();
    await expect(alice.page.getByTestId('ticker')).toHaveCount(0);
  },
);
