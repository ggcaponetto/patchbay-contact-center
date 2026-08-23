/**
 * API keys: a supervisor creates a key with a permission set, a machine uses it as a
 * bearer token and gets exactly that much, revoking it shuts the door (the row stays,
 * marked revoked) and deleting removes it from the list for good.
 */
import { API_ORIGIN } from '../../../../playwright.config.ts';
import { SettingsPage, expect, test } from '../../support/fixtures.ts';

test(
  'an API key created in Settings works as a bearer token with its permissions, until revoked; delete removes it',
  { tag: ['@core', '@settings', '@E2E-36'] },
  async ({ page, request, unique }) => {
    const settings = new SettingsPage(page);
    await settings.goto('api-keys');
    const name = unique('crm');
    await page.getByLabel('Key name').fill(name);
    await page.getByLabel('tenant:read').check();
    await page.getByRole('button', { name: 'Create API key' }).click();
    const secret = await page.getByLabel('New API key').inputValue();
    expect(secret).toMatch(/^ak_[0-9a-f]{64}$/);
    await expect(page.getByText(name, { exact: true })).toBeVisible();

    const bearer = { authorization: `Bearer ${secret}` };
    const calls = await request.get(`${API_ORIGIN}/api/desk/calls`, { headers: bearer });
    expect(calls.status()).toBe(200);
    const tenant = await request.get(`${API_ORIGIN}/api/admin/tenant`, { headers: bearer });
    expect(tenant.status()).toBe(200);
    // not granted
    const state = await request.post(`${API_ORIGIN}/api/desk/state`, {
      headers: bearer,
      data: { state: 'ready' },
    });
    expect(state.status()).toBe(403);

    await page.getByRole('button', { name: `revoke ${name}` }).click();
    await expect(
      page.locator('div').filter({ hasText: name }).getByText('revoked').first(),
    ).toBeVisible();
    await expect
      .poll(async () =>
        (await request.get(`${API_ORIGIN}/api/desk/calls`, { headers: bearer })).status(),
      )
      .toBe(401);

    await page.getByRole('button', { name: `delete ${name}` }).click();
    await settings.confirm();
    await expect(settings.toast).toContainText('Key deleted');
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    const list = await request.get(`${API_ORIGIN}/api/admin/api-keys`);
    expect((await list.json()).some((k: { name: string }) => k.name === name)).toBe(false);
  },
);
