/**
 * The desk on a phone: the tab strip scrolls instead of overflowing, the account controls
 * fold into a menu, tables scroll inside their container (never the page) and every page
 * keeps its landmarks (one `h1`, one `main`) for screen readers.
 */
import {
  DashboardPage,
  DeskPage,
  HistoryPage,
  SettingsPage,
  expect,
  test,
} from '../../support/fixtures.ts';

test.use({ viewport: { width: 390, height: 844 } });

test(
  'the desk works on a phone: scrollable tabs, account menu, no page overflow, landmarks',
  { tag: ['@core', '@desk', '@E2E-61'] },
  async ({ page }) => {
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await expect(page.getByRole('main')).toBeVisible();

    // The Settings tab is the last one: reachable by scrolling the tab strip, and it navigates.
    const settingsTab = page.getByRole('tab', { name: 'Settings' });
    await settingsTab.scrollIntoViewIfNeeded();
    await settingsTab.click();
    await expect(page).toHaveURL(/#\/settings/);
    await new SettingsPage(page).goto('routing');

    // The account controls live in a menu behind the account button.
    await page.getByRole('button', { name: 'Account' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toContainText('Sign out');
    await expect(menu.getByRole('combobox', { name: 'Language' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // History: the table scrolls inside its container; the page itself never overflows.
    const history = new HistoryPage(page);
    await history.goto();
    const overflow = await page.evaluate(() => {
      const container = document.querySelector('.MuiTableContainer-root');
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        table: container ? getComputedStyle(container).overflowX : 'missing',
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.table).toBe('auto');

    // Every page has exactly one h1 and one main landmark.
    const landmarks = async () => ({
      h1: await page.getByRole('heading', { level: 1 }).count(),
      main: await page.getByRole('main').count(),
    });
    await expect.poll(landmarks).toEqual({ h1: 1, main: 1 });
    await deskPage.goto();
    await expect.poll(landmarks).toEqual({ h1: 1, main: 1 });
    await new DashboardPage(page).goto();
    await expect.poll(landmarks).toEqual({ h1: 1, main: 1 });
    await new SettingsPage(page).goto('queues');
    await expect.poll(landmarks).toEqual({ h1: 1, main: 1 });
  },
);
