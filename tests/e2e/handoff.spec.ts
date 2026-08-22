/**
 * The real call path: a customer presses the embedded call button, the AI agent is
 * dispatched by LiveKit Cloud and joins, the desk sees the call, the customer hangs up.
 * Skipped without `LIVEKIT_API_KEY` (no Cloud, no agent worker).
 */
import { expect, test } from '@playwright/test';
import { EMBED_ORIGIN } from '../../playwright.config.ts';

test.skip(!process.env.LIVEKIT_API_KEY, 'needs LiveKit Cloud credentials');

test('customer reaches the AI, asks for a human and the available supervisor is rung', async ({
  page,
  context,
}) => {
  // 1. supervisor creates an embed key and grabs it from the snippet
  await page.goto('/#/settings');
  await page.getByLabel('Label').fill('e2e-handoff');
  await page.getByRole('button', { name: 'Create key' }).click();
  const snippet = await page.getByLabel('Embed snippet').first().inputValue();
  const key = /key="(pk_[a-f0-9]+)"/.exec(snippet)?.[1];
  expect(key).toBeTruthy();

  // ...and goes Available on the desk (a fresh tenant's creator is in the support queue)
  await page.goto('/#/desk');
  await page.getByRole('button', { name: 'Available' }).click();
  await expect(page.getByText('Waiting for calls')).toBeVisible();

  // 2. customer opens "any website" with the button and calls
  const customer = await context.newPage();
  await customer.goto(`${EMBED_ORIGIN}/?key=${key}&api=http://localhost:4100`);
  const button = customer.locator('cc-call-button');
  await button.getByRole('button', { name: 'Call us' }).click();
  await expect(button).toContainText('AI assistant', { timeout: 45_000 });

  // 3. the AI escalates (simulated through the worker's internal endpoint, since the
  //    fake microphone cannot talk) and the desk rings; the supervisor accepts.
  const calls = (await (await page.request.get('/api/desk/calls')).json()) as { id: string }[];
  const callId = calls[0]!.id;
  const escalation = page.request.post(
    `http://localhost:4100/api/internal/calls/${callId}/escalate`,
    {
      headers: { 'x-internal-secret': process.env.INTERNAL_API_SECRET ?? 'e2e-secret' },
      data: { reason: 'e2e', summary: 'Caller wants a person.' },
    },
  );
  await expect(page.getByRole('dialog')).toContainText('Incoming call', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Accept' }).click();
  expect(await (await escalation).json()).toMatchObject({ outcome: 'accepted' });
  await expect(page.getByText('Customer call')).toBeVisible();
  await expect(button).toContainText('Agent', { timeout: 30_000 });

  // 4. the supervisor hangs up -> call ends on both sides
  await page.getByRole('button', { name: 'Hang up' }).click();
  await expect(button).toContainText('Call ended', { timeout: 30_000 });
  await page.goto('/#/history');
  await expect(page.getByText('Ended').first()).toBeVisible({ timeout: 60_000 });

  // 5. embed keys can be deleted again
  await page.goto('/#/settings');
  await page.getByRole('button', { name: 'delete e2e-handoff' }).click();
  await expect(page.getByText('e2e-handoff', { exact: true })).toHaveCount(0);
});
