/**
 * Hold / retrieve and auto-answer: the Hold button parks the customer (music via the
 * media worker; state and events on the call), the timer ticks until Retrieve, and with
 * auto-answer on, offers connect by themselves after the zip tone.
 */
import { DeskPage, admin, desk, expect, test } from '../../support/fixtures.ts';

test(
  'hold parks the customer with a ticking timer until retrieve',
  { tag: ['@core', '@desk', '@E2E-39'] },
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

    await page.getByRole('button', { name: 'Hold' }).click();
    await expect(page.getByRole('button', { name: /Retrieve \(0:0\d\)/ })).toBeVisible();
    await expect
      .poll(async () => (await desk(supervisor.request).call(callId)).heldAt)
      .not.toBeNull();
    await page.getByRole('button', { name: /Retrieve/ }).click();
    await expect(page.getByRole('button', { name: 'Hold' })).toBeVisible();
    const detail = await desk(supervisor.request).call(callId);
    expect(detail.heldAt).toBeNull();
    expect(detail.events.map((e) => e.type)).toEqual(expect.arrayContaining(['hold', 'retrieve']));
  },
);

test(
  'auto-answer connects the offer without a click',
  { tag: ['@core', '@desk', '@E2E-41'] },
  async ({ page, supervisor, tenant, call, ai }) => {
    await admin(supervisor.request).updateSettings({ autoAnswer: true });
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await deskPage.setReady();
    const { callId } = await call(tenant.key);
    const agent = ai(callId);
    await agent.join();
    const outcome = agent.escalate();
    // no click on Accept: the desk answers by itself after the zip tone
    await expect(page.getByText('Customer call')).toBeVisible();
    expect(await outcome).toMatchObject({ outcome: 'accepted' });
    await deskPage.hangUp();
    await admin(supervisor.request).updateSettings({ autoAnswer: false });
  },
);
