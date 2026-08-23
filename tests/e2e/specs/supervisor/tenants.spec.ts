/**
 * Multi-tenancy: a user with several memberships gets a tenant selector, and switching
 * re-scopes everything (history here). Runs last in the core tier because the second
 * tenant stays for the rest of the run.
 */
import { HistoryPage, admin, expect, test } from '../../support/fixtures.ts';

test(
  'a member of two contact centers can switch between them',
  { tag: ['@core', '@supervisor', '@E2E-24'] },
  async ({ page, supervisor, tenant, call, ai }) => {
    const { callId } = await call(tenant.key);
    await ai(callId).join();
    const history = new HistoryPage(page);
    await history.goto();
    await expect(page.getByRole('combobox')).toHaveCount(0);
    await expect(history.rows().first()).toBeVisible();

    await admin(supervisor.request).createTenant('Acme Bikes');
    await page.reload();
    const selector = page.getByRole('combobox');
    await expect(selector).toBeVisible();
    await selector.click();
    await page.getByRole('option', { name: 'Acme Bikes' }).click();
    await expect(selector).toHaveText('Acme Bikes');
    await expect(history.rows()).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
  },
);
