/**
 * The real call path: a customer presses the embedded call button, the AI agent is
 * dispatched by LiveKit Cloud and joins, the desk sees the call, the customer hangs up.
 * Skipped without `LIVEKIT_API_KEY` (no Cloud, no agent worker).
 */
import { expect, test } from '@playwright/test';
import { EMBED_ORIGIN } from '../../playwright.config.ts';

test.skip(!process.env.LIVEKIT_API_KEY, 'needs LiveKit Cloud credentials');

test('customer reaches the AI through the embedded button', async ({ page, context }) => {
  // 1. supervisor creates an embed key and grabs it from the snippet
  await page.goto('/#/settings');
  await page.getByLabel('Label').fill('e2e-handoff');
  await page.getByRole('button', { name: 'Create key' }).click();
  const snippet = await page.getByLabel('Embed snippet').first().inputValue();
  const key = /key="(pk_[a-f0-9]+)"/.exec(snippet)?.[1];
  expect(key).toBeTruthy();

  // 2. customer opens "any website" with the button and calls
  const customer = await context.newPage();
  await customer.goto(`${EMBED_ORIGIN}/?key=${key}&api=http://localhost:4100`);
  const button = customer.locator('cc-call-button');
  await button.getByRole('button', { name: 'Call us' }).click();
  await expect(button).toContainText('AI assistant', { timeout: 45_000 });

  // 3. the desk shows the live call
  await page.goto('/#/history');
  await expect(page.getByText('With AI')).toBeVisible();

  // 4. hang up -> call ends on both sides
  await button.getByRole('button', { name: 'Hang up' }).click();
  await expect(button).toContainText('Call ended');
  await page.reload();
  await expect(page.getByText('Ended').first()).toBeVisible({ timeout: 60_000 });
});
