/**
 * Business hours: while the tenant is closed (forced, holiday or schedule) the embedded
 * button refuses with the configured message; reopening lets calls through again.
 */
import { EmbedButton, admin, expect, test } from '../../support/fixtures.ts';

test(
  'a closed tenant refuses the call with its message until reopened',
  { tag: ['@core', '@embed', '@E2E-50'] },
  async ({ page, supervisor, tenant, call }) => {
    const api = admin(supervisor.request);
    await api.updateSettings({
      hours: { mode: 'closed', closedMessage: 'Closed until Monday 9:00.' },
    });
    const button = new EmbedButton(page);
    await button.goto(tenant.key);
    await button.call();
    await expect(button.element).toContainText(
      'Could not start the call: Closed until Monday 9:00.',
    );

    await api.updateSettings({ hours: { mode: 'off' } });
    const created = await call(tenant.key);
    expect(created.callId).toBeTruthy();
  },
);
