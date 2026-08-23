/**
 * Development login: under the dev-auth bypass the app bar offers "Signed in as …" with
 * every known person; choosing one reloads the desk as them (the `cc_dev_user` cookie).
 */
import { DeskPage, admin, expect, test } from '../../support/fixtures.ts';

test(
  'the app bar switches the desk to another dev user',
  { tag: ['@core', '@desk', '@E2E-33'] },
  async ({ page, supervisor, unique }) => {
    const email = `${unique('colleague')}@example.com`;
    await admin(supervisor.request).invite(email, 'agent');
    const desk = new DeskPage(page);
    await desk.goto();
    await page.getByRole('button', { name: 'Signed in as e2e' }).click();
    // the colleague has not signed in yet: use "Other email…", which creates them
    page.once('dialog', (d) => d.accept(email));
    await page.getByRole('menuitem', { name: 'Other email…' }).click();
    await expect(page.getByText(/^Hi .*, you are/)).toContainText(email.split('@')[0]!);
    await expect(page.getByRole('tab', { name: 'Settings' })).toHaveCount(0);

    // now listed by name; switch back to the supervisor
    await page.getByRole('button', { name: /Signed in as/ }).click();
    await page.getByRole('menuitem', { name: 'e2e e2e@example.com' }).click();
    await expect(page.getByText('Hi e2e, you are')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
  },
);
