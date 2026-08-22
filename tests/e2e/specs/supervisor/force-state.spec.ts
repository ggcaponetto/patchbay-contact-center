/**
 * Supervisor control over agent states from the dashboard: force Ready / Not ready, end
 * a wrap-up, and log an agent out (their desk is disconnected and told who did it).
 */
import { DashboardPage, DeskPage, expect, test } from '../../support/fixtures.ts';

test(
  'a supervisor forces an agent Not ready, back to Ready, and logs them out',
  { tag: ['@core', '@supervisor', '@E2E-35'] },
  async ({ page, queueAgent, unique }) => {
    const agent = await queueAgent(`${unique('agent')}@example.com`);
    const agentDesk = new DeskPage(agent.page);
    await agentDesk.goto();
    await agentDesk.setReady();

    const dashboard = new DashboardPage(page);
    await dashboard.goto();
    const actions = page.getByRole('button', { name: `actions for ${agent.name}` });
    await actions.click();
    await page.getByRole('menuitem', { name: 'Force not ready' }).click();
    await expect(dashboard.agent(agent.name)).toContainText('Supervisor');
    await expect(agentDesk.stateChip()).toContainText('Not ready · Supervisor');

    await actions.click();
    await page.getByRole('menuitem', { name: 'Force ready' }).click();
    await expect(agentDesk.stateChip()).toContainText('Ready');

    await actions.click();
    await page.getByRole('menuitem', { name: 'Log out' }).click();
    await expect(agent.page.getByText('e2e logged you out of the desk.')).toBeVisible();
    await expect(dashboard.agent(agent.name)).toHaveCount(0);
  },
);
