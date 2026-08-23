/**
 * Attribute-based routing: the AI tags an escalation with skills from the tenant's
 * catalogue and the caller's language; only matching agents ring, the desk shows what
 * was asked for, and a queue can relax the requirements after a while (or never).
 */
import { CallPage, DeskPage, HistoryPage, admin, expect, test } from '../../support/fixtures.ts';

/** The catalogue used by both tests. */
const VIP = { key: 'vip', label: 'VIP customers', description: 'Gold and platinum members' };

test(
  'the AI tags skills and language; only a qualified agent rings and sees the chips',
  { tag: ['@core', '@desk', '@E2E-62'] },
  async ({ page, supervisor, queueAgent, unique, tenant, call, ai }) => {
    const a = admin(supervisor.request);
    await a.updateSettings({ skills: [VIP] });

    const alice = await queueAgent(`${unique('alice')}@example.com`);
    const bob = await queueAgent(`${unique('bob')}@example.com`);
    const members = await a.members();
    const aliceId = members.find((m) => m.email === alice.email)!.userId;
    await a.setSkills(aliceId, [{ skill: 'vip', proficiency: 3 }]);
    const aliceDesk = new DeskPage(alice.page);
    const bobDesk = new DeskPage(bob.page);
    await aliceDesk.goto();
    await aliceDesk.setReady();
    await bobDesk.goto();
    await bobDesk.setReady();

    const c = await call(tenant.key);
    const agent = ai(c.callId);
    await agent.join();
    const outcome = agent.escalate('Wants the VIP desk', 'Platinum member, billing issue.', 20, {
      skills: ['vip'],
      language: 'it',
    });
    await aliceDesk.expectRinging();
    await expect(aliceDesk.offerChips()).toContainText(['VIP customers', 'Language: Italiano']);
    await expect(bob.page.getByRole('dialog')).toHaveCount(0);
    await aliceDesk.accept();
    expect((await outcome).outcome).toBe('accepted');

    // the call page and the history row carry the same tags
    const callPage = new CallPage(page);
    await callPage.goto(c.callId);
    await expect(page.getByText('VIP customers', { exact: true })).toBeVisible();
    await expect(page.getByText('Language: Italiano', { exact: true })).toBeVisible();
    const history = new HistoryPage(page);
    await history.goto();
    // the call just made is the newest row
    await expect(history.rows().first()).toContainText('VIP customers');

    await aliceDesk.hangUp();
    await a.updateSettings({ skills: [] });
  },
);

test(
  'a queue relaxes unmet skill requirements after a delay, or never',
  { tag: ['@core', '@desk', '@E2E-63'] },
  async ({ supervisor, queueAgent, unique, tenant, call, ai }) => {
    const a = admin(supervisor.request);
    await a.updateSettings({ skills: [VIP] });
    const support = (await a.queues()).find((q) => q.key === 'support')!;
    const config = (relaxAfterSec: number) => ({
      algorithm: 'longest_idle',
      requiredSkills: [],
      languageRouting: false,
      relaxAfterSec,
    });
    await a.setQueueConfig(support.id, config(3));

    const bob = await queueAgent(`${unique('bob')}@example.com`);
    const bobDesk = new DeskPage(bob.page);
    await bobDesk.goto();
    await bobDesk.setReady();

    // Bob has no `vip` skill: nothing rings until the requirement is relaxed.
    const first = await call(tenant.key);
    const agent1 = ai(first.callId);
    await agent1.join();
    const outcome1 = agent1.escalate('VIP please', 'Platinum member.', 20, { skills: ['vip'] });
    await bob.page.waitForTimeout(1500);
    await expect(bob.page.getByRole('dialog')).toHaveCount(0);
    await expect(bobDesk.dialog).toContainText('Incoming call · support', { timeout: 6000 });
    await expect(bobDesk.offerChips()).toContainText(['VIP customers', 'Requirements relaxed']);
    await bobDesk.accept();
    expect((await outcome1).outcome).toBe('accepted');
    await bobDesk.hangUp();
    // finish the wrap-up so Bob is Ready for the next escalation
    await bob.page.getByRole('button', { name: 'Done' }).click();
    await expect(bob.page.getByText('Waiting for calls')).toBeVisible();

    // `0` never relaxes: the escalation finds nobody and Bob is never rung.
    await a.setQueueConfig(support.id, config(0));
    const second = await call(tenant.key);
    const agent2 = ai(second.callId);
    await agent2.join();
    const outcome2 = await agent2.escalate('VIP please', 'Platinum member.', 5, {
      skills: ['vip'],
    });
    expect(outcome2.outcome).toBe('nobody');
    await expect(bob.page.getByRole('dialog')).toHaveCount(0);

    await a.setQueueConfig(support.id, config(20));
    await a.updateSettings({ skills: [] });
  },
);
