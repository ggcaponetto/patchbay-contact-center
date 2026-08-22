/**
 * The ring cycle seen from the desk: the AI (played through /api/internal) escalates, one
 * available queue member at a time is rung, and accept / decline / timeout each resolve
 * the escalation the way the AI expects.
 */
import { DeskPage, admin, desk, expect, test } from '../../support/fixtures.ts';

test(
  'an escalation rings the available supervisor with the reason and summary',
  { tag: ['@core', '@desk', '@E2E-08'] },
  async ({ page, tenant, call, ai }) => {
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await deskPage.setReady();
    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    const outcome = agent.escalate('Caller insists on a person', 'Order 42 never arrived.', 10);
    await deskPage.expectRinging('support');
    await expect(deskPage.dialog).toContainText('Reason: Caller insists on a person');
    await expect(deskPage.dialog).toContainText('So far: Order 42 never arrived.');
    await expect(deskPage.dialog).toContainText(/\d+s to answer/);
    await deskPage.accept();
    expect(await outcome).toEqual({ outcome: 'accepted', agentName: 'e2e' });
  },
);

test(
  'accepting puts the call with the agent and marks them on a call',
  { tag: ['@core', '@desk', '@E2E-09'] },
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
    expect((await outcome).outcome).toBe('accepted');
    await expect(deskPage.stateChip()).toContainText('On a call');
    const detail = await desk(supervisor.request).call(callId);
    expect(detail.status).toBe('human');
    expect(detail.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['escalation.requested', 'offer.accepted', 'agent.joined']),
    );
    expect(detail.participants.map((p) => p.kind)).toEqual(
      expect.arrayContaining(['customer', 'ai', 'human']),
    );
  },
);

test(
  'a declined offer moves on to the next available agent',
  { tag: ['@core', '@desk', '@E2E-10'] },
  async ({ queueAgent, unique, tenant, call, ai }) => {
    const first = await queueAgent(`${unique('first')}@example.com`);
    const second = await queueAgent(`${unique('second')}@example.com`);
    const firstDesk = new DeskPage(first.page);
    const secondDesk = new DeskPage(second.page);
    await firstDesk.goto();
    await firstDesk.setReady();
    await secondDesk.goto();
    await secondDesk.setReady();

    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    const outcome = agent.escalate();
    await firstDesk.expectRinging();
    await expect(secondDesk.dialog).toHaveCount(0);
    await firstDesk.decline();
    await expect(firstDesk.dialog).toHaveCount(0);
    await secondDesk.expectRinging();
    await secondDesk.accept();
    expect(await outcome).toEqual({ outcome: 'accepted', agentName: second.name });
  },
);

test(
  'an unanswered ring resolves nobody, parks the agent as Not ready (RONA) and returns the call to the AI',
  { tag: ['@core', '@desk', '@E2E-11'] },
  async ({ page, supervisor, tenant, call, ai }) => {
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await deskPage.setReady();
    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    const outcome = agent.escalate('e2e', 'nobody home', 5);
    await deskPage.expectRinging();
    expect(await outcome).toEqual({ outcome: 'nobody' });
    await expect(deskPage.dialog).toHaveCount(0);
    await expect(deskPage.stateChip()).toContainText('Not ready · RONA');
    const detail = await desk(supervisor.request).call(callId);
    expect(detail.status).toBe('ai');
    expect(detail.events.map((e) => e.type)).toContain('offer.nobody');
  },
);

test(
  'away agents and non-members of the queue are never rung',
  { tag: ['@core', '@desk', '@E2E-12'] },
  async ({ page, supervisor, actor, unique, tenant, call, ai }) => {
    // the supervisor is a queue member but away; the outsider is available but not in the queue
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    const email = `${unique('outsider')}@example.com`;
    await admin(supervisor.request).invite(email); // a member of the tenant, not of the queue
    const outsider = await actor(email);
    const outsiderDesk = new DeskPage(outsider.page);
    await outsiderDesk.goto();
    await outsiderDesk.setReady();

    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    expect(await agent.escalate('e2e', 'no candidates', 5)).toEqual({ outcome: 'nobody' });
    await expect(deskPage.dialog).toHaveCount(0);
    await expect(outsiderDesk.dialog).toHaveCount(0);
  },
);
