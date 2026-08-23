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
    // The button must not flicker back to Retrieve while the call detail refetches: watch
    // the DOM for a second and count every appearance of a Retrieve button.
    const flickers = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let seen = 0;
          const check = () => {
            if (
              Array.from(document.querySelectorAll('button')).some((b) =>
                /Retrieve/.test(b.textContent ?? ''),
              )
            )
              seen += 1;
          };
          const observer = new MutationObserver(check);
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
          setTimeout(() => {
            observer.disconnect();
            check();
            resolve(seen);
          }, 1000);
        }),
    );
    expect(flickers).toBe(0);
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
