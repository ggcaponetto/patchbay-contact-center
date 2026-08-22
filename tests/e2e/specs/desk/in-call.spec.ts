/**
 * The agent's side of a call after accepting: the panel, the live transcript, and hanging
 * up — which ends the call for everyone and frees the agent.
 */
import { DeskPage, HistoryPage, desk, expect, test } from '../../support/fixtures.ts';

test(
  'hanging up from the desk ends the call and puts the agent back to Available',
  { tag: ['@core', '@desk', '@E2E-13'] },
  async ({ page, supervisor, tenant, call, ai }) => {
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await deskPage.setAvailable();
    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    const outcome = agent.escalate();
    await deskPage.expectRinging();
    await deskPage.accept();
    await outcome;
    // the transcript keeps flowing while the human is on the call
    await agent.say('Your order is on its way.', 'human');
    await expect(page.getByText('Your order is on its way.')).toBeVisible();

    await deskPage.hangUp();
    await expect(page.getByText('Customer call')).toHaveCount(0);
    await expect(page.getByText('Waiting for calls')).toBeVisible();
    await expect
      .poll(async () => (await desk(supervisor.request).call(callId)).status)
      .toBe('ended');
    const detail = await desk(supervisor.request).call(callId);
    expect(detail.endedAt).not.toBeNull();
    expect(detail.events.map((e) => e.type)).toContain('human.left');
    const history = new HistoryPage(page);
    await history.goto();
    await expect(history.rows().first()).toContainText('Ended');
  },
);
