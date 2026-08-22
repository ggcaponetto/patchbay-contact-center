/**
 * The history table: newest call first, queue, status chip, duration and summary, and a
 * row click opens the call page.
 */
import { HistoryPage, expect, test } from '../../support/fixtures.ts';

test(
  'history lists calls newest first with status, duration and summary',
  { tag: ['@core', '@history', '@E2E-16'] },
  async ({ page, tenant, call, ai }) => {
    const older = await call(tenant.key);
    await ai(older.callId).join();
    await ai(older.callId).end('Older call, resolved.');
    const newer = await call(tenant.key);
    await ai(newer.callId).join();

    const history = new HistoryPage(page);
    await history.goto();
    const rows = history.rows();
    await expect(rows.first()).toContainText('With AI');
    await expect(rows.first()).toContainText('support');
    await expect(rows.first()).toContainText(/0:0\d/);
    await expect(rows.nth(1)).toContainText('Ended');
    await expect(rows.nth(1)).toContainText('Older call, resolved.');

    // the status refreshes live when the newer call ends
    await ai(newer.callId).end();
    await expect(rows.first()).toContainText('Ended');
    await rows.first().click();
    await expect(page).toHaveURL(new RegExp(`#/calls/${newer.callId}`));
  },
);
