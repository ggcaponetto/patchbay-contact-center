/**
 * Call recording from the desk: start, a PCI pause / resume gap, stop. The API runs with
 * `RECORDING_STUB=true`, so the state machine and the journal are exercised without any
 * Egress or S3 involved.
 */
import { DeskPage, desk, expect, test } from '../../support/fixtures.ts';

test(
  'recording starts, pauses as a PCI-safe gap, resumes and stops, all journaled',
  { tag: ['@core', '@desk', '@E2E-44'] },
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

    await page.getByRole('button', { name: 'Record', exact: true }).click();
    await expect(page.getByText('REC', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Pause recording' }).click();
    await expect(page.getByText('REC paused')).toBeVisible();
    await page.getByRole('button', { name: 'Resume recording' }).click();
    await expect(page.getByText('REC', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeVisible();

    const detail = await desk(supervisor.request).call(callId);
    expect(detail.recordingState).toBe('off');
    expect(detail.events.map((e) => e.type)).toEqual(
      expect.arrayContaining([
        'recording.start',
        'recording.pause',
        'recording.resume',
        'recording.stop',
      ]),
    );
  },
);
