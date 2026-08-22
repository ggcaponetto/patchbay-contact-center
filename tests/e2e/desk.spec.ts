/**
 * Desk smoke test: the dev-auth user is a supervisor of a bootstrapped tenant, can
 * toggle availability (websocket presence) and sees themselves on the dashboard.
 * Needs only the API + web servers (no LiveKit Cloud).
 */
import { expect, test } from '@playwright/test';

test('supervisor signs in, goes available and appears on the dashboard', async ({ page }) => {
  await page.goto('/#/desk');
  await expect(page.getByText(/Hi e2e, you are/)).toBeVisible();
  await page.getByRole('button', { name: 'Available' }).click();
  await expect(page.getByText('Waiting for calls')).toBeVisible();
  await page.getByRole('tab', { name: 'Dashboard' }).click();
  await expect(page.getByText('Agents online (1)')).toBeVisible();
  await expect(page.getByText('available', { exact: true })).toBeVisible();
});

test('settings lets a supervisor create an embed key with a snippet', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByLabel('Label').fill('playwright');
  await page.getByRole('button', { name: 'Create key' }).click();
  await expect(page.getByText('playwright', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Embed snippet').first()).toHaveValue(/cc-call-button key="pk_/);
});
