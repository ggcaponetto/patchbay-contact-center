/**
 * Monitoring and intervention beyond listen/take-over: whisper (agent hears the
 * supervisor, the customer never does), the monitoring notification on the agent's desk,
 * and intercept (the supervisor takes the call and the agent is dropped and freed).
 */
import { CallPage, DeskPage, desk, expect, test } from '../../support/fixtures.ts';

test(
  'whispering notifies the agent and never reaches the customer',
  { tag: ['@core', '@supervisor', '@E2E-45'] },
  async ({ page, supervisor, queueAgent, unique, tenant, call, ai }) => {
    const alice = await queueAgent(`${unique('alice')}@example.com`);
    const aliceDesk = new DeskPage(alice.page);
    await aliceDesk.goto();
    await aliceDesk.setReady();
    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    const outcome = agent.escalate();
    await aliceDesk.expectRinging();
    await aliceDesk.accept();
    await outcome;

    const callPage = new CallPage(page);
    await callPage.goto(callId);
    await page.getByRole('button', { name: 'Whisper' }).click();
    await expect(page.getByText('Whispering to the agent')).toBeVisible();
    // the agent is told a supervisor is on the call (monitorNotify defaults to on)
    await expect(alice.page.getByText('A supervisor is on this call')).toBeVisible();
    const detail = await desk(supervisor.request).call(callId);
    expect(detail.status).toBe('human'); // whisper never hijacks the call
    expect(detail.events.map((e) => e.type)).toContain('whisper.joined');
    await callPage.hangUp();
    await expect(alice.page.getByText('A supervisor is on this call')).toHaveCount(0);
  },
);

test(
  'intercepting drops the agent, frees them, and the supervisor keeps the customer',
  { tag: ['@core', '@supervisor', '@E2E-46'] },
  async ({ page, supervisor, queueAgent, unique, tenant, call, ai }) => {
    const bob = await queueAgent(`${unique('bob')}@example.com`);
    const bobDesk = new DeskPage(bob.page);
    await bobDesk.goto();
    await bobDesk.setReady();
    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    const outcome = agent.escalate();
    await bobDesk.expectRinging();
    await bobDesk.accept();
    await outcome;

    const callPage = new CallPage(page);
    await callPage.goto(callId);
    await page.getByRole('button', { name: 'Intercept' }).click();
    await expect(page.getByText('You intercepted this call')).toBeVisible();
    const detail = await desk(supervisor.request).call(callId);
    expect(detail.status).toBe('human');
    expect(detail.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['intercept', 'intercept.joined']),
    );
    // exactly one live human remains: the supervisor; Bob's row is closed and he is freed
    const humans = detail.participants.filter((p) => p.kind === 'human' && p.leftAt === null);
    expect(humans).toHaveLength(1);
    await expect(bobDesk.stateChip()).not.toHaveText('Busy');
  },
);
