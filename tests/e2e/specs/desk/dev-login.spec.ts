/**
 * Development login: under the dev-auth bypass the app bar offers "Signed in as …" with
 * every known person; choosing one reloads the desk as them. The identity is per browser
 * tab (`sessionStorage` + the `x-dev-user` header), so "Open in new tab" puts a second
 * person next to the first one in the same browser, and a plain new tab is the default
 * user again.
 */
import { DashboardPage, DeskPage, admin, expect, test } from '../../support/fixtures.ts';

test(
  'the app bar switches the desk to another dev user, one identity per tab',
  { tag: ['@core', '@desk', '@E2E-33'] },
  async ({ page, context, supervisor, unique }) => {
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

    // the choice is per tab: a fresh tab in the same browser is the default user
    const fresh = await context.newPage();
    await fresh.goto('/');
    await expect(fresh.getByText('Hi e2e, you are')).toBeVisible();
    await fresh.close();

    // now listed by name; switch back to the supervisor
    await page.getByRole('button', { name: /Signed in as/ }).click();
    await page.getByRole('menuitem', { name: 'e2e e2e@example.com' }).click();
    await expect(page.getByText('Hi e2e, you are')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
  },
);

test(
  '"Open in new tab" signs a second person in next to the supervisor, both online',
  { tag: ['@core', '@desk', '@E2E-58'] },
  async ({ page, supervisor, unique }) => {
    // the demo team is off in e2e, so invite the colleague first
    const email = `${unique('alice')}@patchbay.dev`;
    const name = email.split('@')[0]!;
    await admin(supervisor.request).invite(email, 'agent');
    // the menu lists people who exist: one request as them creates the user
    await supervisor.request.get('/api/me', { headers: { 'x-dev-user': email } });

    const desk = new DeskPage(page);
    await desk.goto();
    await page.getByRole('button', { name: 'Signed in as e2e' }).click();
    const popup = page.waitForEvent('popup');
    await page.getByRole('button', { name: `Open in new tab as ${name}` }).click();
    const tab = await popup;
    const agentDesk = new DeskPage(tab);
    await expect(tab.getByText(`Hi ${name}, you are`)).toBeVisible();
    // the `as` parameter is consumed and gone from the address bar
    await expect.poll(() => tab.url()).not.toContain('as=');
    // the first tab is still the supervisor
    await expect(page.getByText('Hi e2e, you are')).toBeVisible();

    await agentDesk.setReady();
    await desk.setReady();
    const dashboard = new DashboardPage(page);
    await dashboard.goto();
    await expect(dashboard.agent('e2e')).toContainText('Ready');
    await expect(dashboard.agent(name)).toContainText('Ready');
    await tab.close();
  },
);
