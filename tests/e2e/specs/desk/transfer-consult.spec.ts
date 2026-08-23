/**
 * Blind transfer and consultation between two agents. The customer is parked with hold
 * music while a transfer rings and during a consultation; completing the consult hands
 * the call over, conferences everyone, or drops the consultant.
 */
import { DeskPage, desk, expect, test } from '../../support/fixtures.ts';

test(
  'a blind transfer rings the chosen colleague and hands them the retrieved customer',
  { tag: ['@core', '@desk', '@E2E-42'] },
  async ({ page, supervisor, queueAgent, unique, tenant, call, ai }) => {
    // the supervisor goes ready first: the earliest ready agent is rung, and that must
    // be us so Bob stays available as the transfer target
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await deskPage.setReady();
    const bob = await queueAgent(`${unique('bob')}@example.com`);
    const bobDesk = new DeskPage(bob.page);
    await bobDesk.goto();
    await bobDesk.setReady();

    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    const outcome = agent.escalate();
    await deskPage.expectRinging();
    await deskPage.accept();
    await outcome;

    await page.getByRole('button', { name: 'Transfer' }).click();
    await page.getByRole('menuitem', { name: bob.name }).click();
    // my panel closes, I am free again; Bob rings with the transfer reason
    await expect(page.getByText('Customer call')).toHaveCount(0);
    await bobDesk.expectRinging();
    await expect(bobDesk.dialog).toContainText('Transfer from e2e');
    // the customer waits with music meanwhile
    expect((await desk(supervisor.request).call(callId)).heldAt).not.toBeNull();
    await bobDesk.accept();
    await expect.poll(async () => (await desk(supervisor.request).call(callId)).heldAt).toBeNull();
    const detail = await desk(supervisor.request).call(callId);
    expect(detail.status).toBe('human');
    expect(detail.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['transfer', 'hold', 'retrieve', 'offer.accepted']),
    );
  },
);

test(
  'a consultation holds the customer, and completing hands the call to the consultant',
  { tag: ['@core', '@desk', '@E2E-43'] },
  async ({ page, supervisor, queueAgent, unique, tenant, call, ai }) => {
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await deskPage.setReady();
    const carol = await queueAgent(`${unique('carol')}@example.com`);
    const carolDesk = new DeskPage(carol.page);
    await carolDesk.goto();
    await carolDesk.setReady();

    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    const outcome = agent.escalate();
    await deskPage.expectRinging();
    await deskPage.accept();
    await outcome;

    await page.getByRole('button', { name: 'Consult' }).click();
    await page.getByRole('menuitem', { name: carol.name }).click();
    await carolDesk.expectRinging();
    await expect(carolDesk.dialog).toContainText('Consultation with e2e');
    expect((await desk(supervisor.request).call(callId)).heldAt).not.toBeNull();
    await carolDesk.accept();

    // both desks are on the call; my completion buttons appear
    await expect(page.getByRole('button', { name: `Hand over to ${carol.name}` })).toBeVisible();
    // drop the consultant: my buttons revert, Carol is free again
    await page.getByRole('button', { name: `Drop ${carol.name}` }).click();
    await expect(page.getByRole('button', { name: 'Consult' })).toBeVisible();
    await expect
      .poll(async () => (await desk(supervisor.request).call(callId)).events.map((e) => e.type))
      .toContain('consult.dropped');

    // Carol's desk still shows the stale panel (no real room closes it here): hanging up
    // is safe — another human is on the call, so it only folds her side.
    await carolDesk.hangUp();
    await expect
      .poll(async () =>
        (await desk(supervisor.request).call(callId)).participants.filter(
          (p) => p.kind === 'human' && p.leftAt === null,
        ),
      )
      .toHaveLength(1);
    // consult again and hand the call over
    await carolDesk.setReady();
    await page.getByRole('button', { name: 'Consult' }).click();
    await page.getByRole('menuitem', { name: carol.name }).click();
    await carolDesk.expectRinging();
    await carolDesk.accept();
    await page.getByRole('button', { name: `Hand over to ${carol.name}` }).click();
    await expect(page.getByText('Customer call')).toHaveCount(0);
    const detail = await desk(supervisor.request).call(callId);
    expect(detail.heldAt).toBeNull();
    expect(detail.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['consult', 'transfer.completed']),
    );
  },
);
