/**
 * Team: a supervisor invites a colleague; the invite is pending until that person signs
 * in for the first time, then they are a member with the invited role and see only what
 * the role allows.
 */
import { DeskPage, SettingsPage, admin, expect, test } from '../../support/fixtures.ts';

test(
  'an invited agent becomes a member on first sign-in',
  { tag: ['@core', '@settings', '@E2E-21'] },
  async ({ page, supervisor, actor, unique }) => {
    const email = `${unique('newcomer')}@example.com`;
    const settings = new SettingsPage(page);
    await settings.goto();
    await settings.invite(email, 'agent');
    await expect(page.getByText(email).locator('..')).toContainText('invited as agent');

    // first sign-in accepts the invite (bootstrapUser)
    const newcomer = await actor(email);
    const newcomerDesk = new DeskPage(newcomer.page);
    await newcomerDesk.goto();
    await expect(newcomer.page.getByRole('tab', { name: 'Settings' })).toHaveCount(0);
    expect(await admin(supervisor.request).members()).toEqual(
      expect.arrayContaining([expect.objectContaining({ email, role: 'agent' })]),
    );
    await page.reload();
    await expect(page.getByText('invited as agent')).toHaveCount(0);
    await expect(page.getByText(email).locator('..')).toContainText('agent');
  },
);
