/**
 * Wrap-up codes: a supervisor defines them in Settings → Routing & AI (label + code, the
 * code derived from the label), an agent picks one after a call, and history shows the
 * label rather than the code.
 */
import { DeskPage, SettingsPage, admin, expect, test } from '../../support/fixtures.ts';

test(
  'wrap-up codes defined in Settings are offered after a call and labelled in history',
  { tag: ['@core', '@settings', '@E2E-55'] },
  async ({ page, supervisor, tenant, call, ai }) => {
    const settings = new SettingsPage(page);
    await settings.goto('routing');
    await page.getByRole('button', { name: 'Add examples' }).click();
    await page.getByRole('button', { name: '+ Add code' }).click();
    await page
      .getByRole('textbox', { name: 'Label', exact: true })
      .last()
      .fill('Documentation update');
    await expect(page.getByRole('textbox', { name: 'Code', exact: true }).last()).toHaveValue(
      'documentation-update',
    );
    await page.getByRole('button', { name: 'remove code Callback scheduled' }).click();
    await page.getByLabel('Wrap-up time (s, 0 = off)').fill('30');
    await settings.save();
    await expect(settings.toast).toContainText('saved');
    await expect
      .poll(async () => (await admin(supervisor.request).tenant()).settings.dispositions)
      .toEqual([
        { code: 'resolved', label: 'Resolved' },
        { code: 'ticket', label: 'Created ticket' },
        { code: 'docs', label: 'Documentation update' },
        { code: 'escalated', label: 'Escalated' },
        { code: 'documentation-update', label: 'Documentation update' },
      ]);

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
    await page.getByLabel('Disposition').click();
    await page.getByRole('option', { name: 'Created ticket' }).click();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(deskPage.stateChip()).toContainText('Ready');

    await page.goto('/#/history');
    await expect(page.getByRole('cell', { name: 'Created ticket' }).first()).toBeVisible();
    await page.goto(`/#/calls/${callId}`);
    await expect(page.getByText('Created ticket', { exact: true })).toBeVisible();

    await admin(supervisor.request).updateSettings({ dispositions: [], acwSec: 30 });
  },
);
