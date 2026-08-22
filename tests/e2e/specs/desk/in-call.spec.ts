/**
 * The agent's side of a call after accepting: the panel, the live transcript, hanging up
 * — which ends the call for everyone — and the wrap-up (after-call work) that follows.
 */
import { DeskPage, HistoryPage, admin, desk, expect, test } from '../../support/fixtures.ts';

test(
  'hanging up from the desk ends the call and puts the agent into wrap-up',
  { tag: ['@core', '@desk', '@E2E-13'] },
  async ({ page, supervisor, tenant, call, ai }) => {
    await admin(supervisor.request).updateSettings({ acwSec: 20 });
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await deskPage.setReady();
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
    await expect(deskPage.stateChip()).toContainText('Wrap-up');
    await expect(page.getByText(/Wrap-up: \d+s left/)).toBeVisible();
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

test(
  'wrap-up can be extended and finished early; with acwSec 0 the agent is Ready at once',
  { tag: ['@core', '@desk', '@E2E-34'] },
  async ({ page, supervisor, tenant, call, ai }) => {
    await admin(supervisor.request).updateSettings({ acwSec: 20 });
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await deskPage.setReady();
    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    const outcome = agent.escalate();
    await deskPage.expectRinging();
    await deskPage.accept();
    await outcome;
    await deskPage.hangUp();
    await expect(page.getByText(/Wrap-up: (1\d|20)s left/)).toBeVisible();
    await page.getByRole('button', { name: 'Extend' }).click();
    await expect(page.getByText(/Wrap-up: (3\d|40)s left/)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(deskPage.stateChip()).toContainText('Ready');
    await expect(page.getByText('Waiting for calls')).toBeVisible();

    await admin(supervisor.request).updateSettings({ acwSec: 0 });
    const second = await call(tenant.key);
    const agent2 = ai(second.callId);
    await agent2.join();
    const outcome2 = agent2.escalate();
    await deskPage.expectRinging();
    await deskPage.accept();
    await outcome2;
    await deskPage.hangUp();
    await expect(deskPage.stateChip()).toContainText('Ready');
    await admin(supervisor.request).updateSettings({ acwSec: 30 });
  },
);
