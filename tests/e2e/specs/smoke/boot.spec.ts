/**
 * The stack is up: API health, the desk renders for the signed-in dev user, the embed
 * demo page shows the button. If this fails nothing else is worth looking at.
 */
import { API_ORIGIN } from '../../../../playwright.config.ts';
import { DeskPage, EmbedButton, expect, test } from '../../support/fixtures.ts';

test(
  'API answers, the desk signs the dev user in and the embed page renders the button',
  { tag: ['@smoke', '@desk', '@embed', '@E2E-01'] },
  async ({ page, request, tenant }) => {
    expect(await (await request.get(`${API_ORIGIN}/api/health`)).json()).toEqual({ ok: true });
    await new DeskPage(page).goto();
    await expect(page.getByRole('tab', { name: 'Settings' })).toBeVisible();
    await new EmbedButton(page).goto(tenant.key);
    await expect(page.getByText(`Using key ${tenant.key}.`)).toBeVisible();
  },
);
