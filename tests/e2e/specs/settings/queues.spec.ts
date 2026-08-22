/**
 * Queues: a supervisor creates one (the key is slugified), assigns members, and a call
 * started with that queue rings only its members.
 */
import { DeskPage, SettingsPage, admin, expect, test } from '../../support/fixtures.ts';

test(
  'a new queue gets a slug key and rings only its members',
  { tag: ['@core', '@settings', '@E2E-22'] },
  async ({ page, supervisor, queueAgent, unique, tenant, call, ai }) => {
    const vip = await queueAgent(`${unique('vip')}@example.com`);
    const other = await queueAgent(`${unique('other')}@example.com`);
    const name = `VIP ${unique('Sales')}`;
    const settings = new SettingsPage(page);
    await settings.goto();
    await settings.addQueue(name);
    const queue = (await admin(supervisor.request).queues()).find((q) => q.name === name)!;
    expect(queue.key).toBe(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    await expect(page.getByText(queue.key)).toBeVisible();
    // controlled checkbox: it flips once the PUT has gone through and the list refetched
    await settings.queueMember(name, vip.name).click();
    await expect(settings.queueMember(name, vip.name)).toBeChecked();
    await expect
      .poll(
        async () =>
          (await admin(supervisor.request).queues()).find((q) => q.id === queue.id)!.memberIds,
      )
      .toHaveLength(1);

    const vipDesk = new DeskPage(vip.page);
    const otherDesk = new DeskPage(other.page);
    await vipDesk.goto();
    await vipDesk.setReady();
    await otherDesk.goto();
    await otherDesk.setReady();
    const { callId } = await call(tenant.key, { queue: queue.key });
    const agent = ai(callId);
    await agent.join();
    const outcome = agent.escalate();
    await vipDesk.expectRinging(queue.key);
    await expect(otherDesk.dialog).toHaveCount(0);
    await vipDesk.accept();
    expect(await outcome).toEqual({ outcome: 'accepted', agentName: vip.name });
  },
);
