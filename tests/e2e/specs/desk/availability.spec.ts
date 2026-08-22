/**
 * Presence: the Available/Away toggle over the desk websocket, what the dashboard shows
 * for it, and that presence follows the socket (closing the tab takes the agent offline).
 */
import { DashboardPage, DeskPage, admin, expect, test } from '../../support/fixtures.ts';

test(
  'supervisor goes Available and appears on the dashboard as available',
  { tag: ['@smoke', '@desk', '@E2E-02'] },
  async ({ page }) => {
    const desk = new DeskPage(page);
    await desk.goto();
    await desk.setAvailable();
    const dashboard = new DashboardPage(page);
    await dashboard.goto();
    await expect(dashboard.agentsOnline()).toHaveText('Agents online (1)');
    await expect(dashboard.agent('e2e')).toContainText('available');
    await page.getByRole('tab', { name: 'Desk' }).click();
    await desk.setAway();
    await dashboard.goto();
    await expect(dashboard.agent('e2e')).toContainText('away');
  },
);

test(
  'an agent who closes the desk disappears from Agents online',
  { tag: ['@core', '@desk', '@E2E-25'] },
  async ({ page, supervisor, actor, unique }) => {
    const email = `${unique('agent')}@example.com`;
    await admin(supervisor.request).invite(email);
    const agent = await actor(email);
    const agentDesk = new DeskPage(agent.page);
    await agentDesk.goto();
    await agentDesk.setAvailable();

    // the supervisor's own (away) desk socket counts too
    const dashboard = new DashboardPage(page);
    await dashboard.goto();
    await expect(dashboard.agentsOnline()).toHaveText('Agents online (2)');
    await expect(dashboard.agent(agent.name)).toContainText('available');

    await agent.close();
    await expect(dashboard.agentsOnline()).toHaveText('Agents online (1)');
    await expect(dashboard.agent(agent.name)).toHaveCount(0);
  },
);
