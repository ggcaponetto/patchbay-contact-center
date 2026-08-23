/**
 * Skills editing: the chip editor in Settings → Team & skills saves a member's skills
 * with explicit levels, the saved chips survive a reload, and a queue's requirement is
 * edited the same way.
 */
import { SettingsPage, admin, expect, test } from '../../support/fixtures.ts';

test(
  'member and queue skills are edited as chips and persisted',
  { tag: ['@core', '@settings', '@E2E-56'] },
  async ({ page, supervisor, queueAgent, unique }) => {
    const agent = await queueAgent(`${unique('skilled')}@example.com`);
    const settings = new SettingsPage(page);
    await settings.goto('team');
    await settings.addSkill(`Add a skill to ${agent.name}`, 'billing', 3);
    await settings.addSkill(`Add a skill to ${agent.name}`, 'lang:de', 5);
    await page.getByRole('button', { name: `Save skills of ${agent.name}` }).click();
    await expect(settings.toast).toContainText(`Skills of ${agent.name} saved`);
    const a = admin(supervisor.request);
    const userId = (await a.members()).find((m) => m.email === agent.email)!.userId;
    await expect
      .poll(() => a.skills(userId))
      .toEqual(
        expect.arrayContaining([
          { skill: 'billing', proficiency: 3 },
          { skill: 'lang:de', proficiency: 5 },
        ]),
      );

    await page.reload();
    await settings.tab('team');
    await expect(page.getByText('billing · level 3')).toBeVisible();
    await expect(page.getByText('lang:de · level 5')).toBeVisible();

    await settings.tab('queues');
    await settings.addSkill('Required skills for Support', 'billing', 2);
    await page.getByRole('button', { name: 'Save routing of Support' }).click();
    await expect(settings.toast).toContainText('Routing of Support saved');
    const support = (await a.queues()).find((q) => q.key === 'support')!;
    expect(support.config).toMatchObject({ requiredSkills: [{ skill: 'billing', min: 2 }] });
    await a.setQueueConfig(support.id, {
      algorithm: 'longest_idle',
      requiredSkills: [],
      languageRouting: false,
    });
  },
);
