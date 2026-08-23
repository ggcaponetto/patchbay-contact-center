/**
 * In-call annotations and wrap-up codes: notes and tags land on the call, dispositions
 * come from the tenant settings and — when mandatory — gate the end of wrap-up.
 */
import { DeskPage, admin, desk, expect, test } from '../../support/fixtures.ts';

test(
  'notes and tags written during the call show up on the call page and in history',
  { tag: ['@core', '@desk', '@E2E-37'] },
  async ({ page, supervisor, tenant, call, ai }) => {
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

    await page.getByLabel('Note').fill('Caller wants a refund');
    await page.getByRole('button', { name: 'Add note' }).click();
    await page.getByLabel('Tags (comma separated)').fill('vip, refund');
    await page.getByRole('button', { name: 'Save tags' }).click();
    await expect
      .poll(async () => (await desk(supervisor.request).call(callId)).tags)
      .toEqual(['vip', 'refund']);
    await deskPage.hangUp();

    await page.goto(`/#/calls/${callId}`);
    await expect(page.getByText('vip', { exact: true })).toBeVisible();
    await expect(page.getByText('refund', { exact: true })).toBeVisible();
    await expect(page.getByText('Events').locator('..')).toContainText('note');
    const detail = await desk(supervisor.request).call(callId);
    expect(detail.events.find((e) => e.type === 'note')?.payload).toMatchObject({
      text: 'Caller wants a refund',
    });
  },
);

test(
  'a mandatory disposition blocks Done until it is picked in the wrap-up bar',
  { tag: ['@core', '@desk', '@E2E-38'] },
  async ({ page, supervisor, tenant, call, ai }) => {
    await admin(supervisor.request).updateSettings({
      acwSec: 30,
      dispositions: [
        { code: 'billing/refund', label: 'Refund' },
        { code: 'resolved', label: 'Resolved' },
      ],
      dispositionRequired: true,
    });
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

    await expect(page.getByText(/Wrap-up: \d+s left/)).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText(/disposition_required/)).toBeVisible();
    await page.getByLabel('Disposition').click();
    await page.getByRole('option', { name: 'billing · Refund' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(deskPage.stateChip()).toContainText('Ready');

    const history = page;
    await history.goto('/#/history');
    await expect(page.getByRole('cell', { name: 'billing · Refund' })).toBeVisible();
    await admin(supervisor.request).updateSettings({
      acwSec: 30,
      dispositions: [],
      dispositionRequired: false,
    });
  },
);
