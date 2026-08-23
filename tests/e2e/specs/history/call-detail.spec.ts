/**
 * The call page: the live transcript as the AI and the customer speak, the event
 * timeline, and the AI summary once the call has ended.
 */
import { CallPage, expect, test } from '../../support/fixtures.ts';

test(
  'transcript segments appear live and in order on the call page',
  { tag: ['@core', '@history', '@E2E-14'] },
  async ({ page, tenant, call, ai }) => {
    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    await agent.say('Hello, how can I help you today?');
    const callPage = new CallPage(page);
    await callPage.goto(callId);
    await expect(callPage.transcript()).toContainText('Hello, how can I help you today?');
    await agent.say('I would like to change my booking.', 'customer');
    await agent.say('Sure, which date would you prefer?');
    const items = callPage.transcript().getByRole('listitem');
    await expect(items).toHaveCount(3);
    await expect(items.nth(1)).toContainText('I would like to change my booking.');
    await expect(items.nth(1)).toContainText('customer');
    await expect(items.nth(2)).toContainText('Sure, which date would you prefer?');
  },
);

test(
  'the call page shows status, events and the AI summary after the call ends',
  { tag: ['@core', '@history', '@E2E-15'] },
  async ({ page, tenant, call, ai }) => {
    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    const callPage = new CallPage(page);
    await callPage.goto(callId);
    await expect(callPage.statusChip()).toHaveText('With AI');
    await expect(page.getByText('support', { exact: true })).toBeVisible();
    await expect(callPage.events()).toContainText('call.created');
    await expect(callPage.events()).toContainText('ai.joined');
    // free-form events are fetched with the detail; the list refreshes on status changes
    await agent.event('tool.called', { name: 'lookupOrder' });
    await agent.end('The caller asked about order 42; it ships tomorrow.');
    await expect(callPage.statusChip()).toHaveText('Ended');
    await expect(callPage.events()).toContainText('tool.called');
    await page.reload();
    await expect(
      page.getByText('AI summary: The caller asked about order 42; it ships tomorrow.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Listen in' })).toHaveCount(0);
  },
);
