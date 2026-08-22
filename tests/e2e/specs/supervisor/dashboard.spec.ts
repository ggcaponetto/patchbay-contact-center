/**
 * The supervisor dashboard: live calls with their status and the role gate around the
 * supervisor-only surface (tabs in the UI, `/join` in the API).
 */
import { DashboardPage, DeskPage, desk, expect, test } from '../../support/fixtures.ts';

test(
  'a new call shows up live on the dashboard as With AI and opens its detail page',
  { tag: ['@core', '@supervisor', '@E2E-07'] },
  async ({ page, unique, tenant, call, ai }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.goto();
    await expect(page.getByText('No calls in progress.')).toBeVisible();
    const site = `https://${unique('shop')}.example/pricing`;
    const { callId } = await call(tenant.key, { page: site });
    await ai(callId).join();
    await expect(dashboard.liveCalls()).toHaveText('Live calls (1)');
    const row = dashboard.call('support').filter({ hasText: site });
    await expect(row).toContainText('With AI');
    await expect(row).toContainText(/support · 0:0\d/);
    await row.click();
    await expect(page).toHaveURL(new RegExp(`#/calls/${callId}`));
    await ai(callId).end();
    await dashboard.goto();
    await expect(page.getByText('No calls in progress.')).toBeVisible();
  },
);

test(
  'an agent sees neither Dashboard nor Settings and cannot join calls',
  { tag: ['@core', '@supervisor', '@E2E-19'] },
  async ({ queueAgent, unique, tenant, call }) => {
    const agent = await queueAgent(`${unique('agent')}@example.com`);
    await new DeskPage(agent.page).goto();
    await expect(agent.page.getByRole('tab', { name: 'Desk' })).toBeVisible();
    await expect(agent.page.getByRole('tab', { name: 'History' })).toBeVisible();
    await expect(agent.page.getByRole('tab', { name: 'Dashboard' })).toHaveCount(0);
    await expect(agent.page.getByRole('tab', { name: 'Settings' })).toHaveCount(0);
    const { callId } = await call(tenant.key);
    const res = await desk(agent.request).join(callId, 'listen');
    expect(res.status()).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  },
);
