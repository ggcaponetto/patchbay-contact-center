/**
 * Wallboard and threshold alerts: the read-only big-number view shows live counts and
 * turns red when a `TenantSettings.alerts` threshold is breached.
 */
import { admin, expect, test } from '../../support/fixtures.ts';

test(
  'the wallboard shows live counts and raises a threshold alert',
  { tag: ['@core', '@supervisor', '@E2E-48'] },
  async ({ page, supervisor, tenant, call, ai }) => {
    // a running call older than 1s breaches the longest-call threshold immediately
    await admin(supervisor.request).updateSettings({
      alerts: { maxWaiting: 0, maxWaitSec: 0, maxCallSec: 1 },
    });
    const { callId } = await call(tenant.key);
    await ai(callId).join();

    await page.goto('/#/wallboard');
    await expect(page.getByText('Active calls')).toBeVisible();
    // the breached metric is listed as a red banner with the configured limit
    await expect(page.getByText('(limit 1s)', { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // clearing the threshold clears the alert on the next poll
    await admin(supervisor.request).updateSettings({
      alerts: { maxWaiting: 0, maxWaitSec: 0, maxCallSec: 0 },
    });
    await expect(page.getByText('(limit 1s)', { exact: false })).toHaveCount(0, {
      timeout: 15_000,
    });
  },
);
