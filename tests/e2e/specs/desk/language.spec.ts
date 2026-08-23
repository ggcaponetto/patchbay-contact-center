/**
 * The desk speaks the language chosen in the app bar: the menu switches every label at
 * once, the choice survives a reload through the `cc_lng` cookie. The suite pins every
 * context to English (see `support/actors.ts`), so a dedicated actor switches here.
 */
import { readFileSync } from 'node:fs';
import { DeskPage, expect, test } from '../../support/fixtures.ts';

/** The German labels, read from the desk's own translation file (no JSON import attributes in ES2022). */
const de = JSON.parse(
  readFileSync(
    new URL('../../../../apps/web/src/locales/de/translation.json', import.meta.url),
    'utf8',
  ),
) as typeof import('../../../../apps/web/src/locales/de/translation.json');

test(
  'the language menu switches the desk to German and the choice survives a reload',
  { tag: ['@core', '@desk', '@E2E-59'] },
  async ({ queueAgent, unique }) => {
    const agent = await queueAgent(`${unique('polyglot')}@example.com`);
    const { page } = agent;
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await expect(page.getByRole('tab', { name: 'History' })).toBeVisible();

    await page.getByRole('combobox', { name: 'Language' }).click();
    await page.getByRole('option', { name: 'Deutsch' }).click();

    await expect(page.getByRole('tab', { name: de.app.tabs.history })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'History' })).toHaveCount(0);
    await expect(
      page.getByText(de.stateBar.greeting.replace('{{name}}', agent.name)),
    ).toBeVisible();
    await expect(
      page.getByText(new RegExp(`^${de.states.not_ready} · \\d+:\\d\\d$`)),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: de.stateBar.ready, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('de');
    const cookie = (await agent.context.cookies()).find((c) => c.name === 'cc_lng');
    expect(cookie?.value).toBe('de');

    await page.reload();
    await expect(page.getByRole('tab', { name: de.app.tabs.history })).toBeVisible();
    await expect(page.getByRole('combobox', { name: de.app.language })).toHaveText('Deutsch');

    await page.getByRole('combobox', { name: de.app.language }).click();
    await page.getByRole('option', { name: 'English' }).click();
    await expect(page.getByRole('tab', { name: 'History' })).toBeVisible();
  },
);
