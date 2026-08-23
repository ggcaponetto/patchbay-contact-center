/**
 * The call button speaks the customer's language: `language` picks the translation of
 * its texts (en, de, it; regional tags normalize, anything else falls back to English)
 * while an explicit `label` attribute always wins. No LiveKit needed: nothing is clicked.
 */
import { readFileSync } from 'node:fs';
import { EmbedButton, expect, test } from '../../support/fixtures.ts';

/** The German texts, read from the button's own translation file (no JSON import attributes in ES2022). */
const de = JSON.parse(
  readFileSync(new URL('../../../../apps/embed/src/locales/de.json', import.meta.url), 'utf8'),
) as typeof import('../../../../apps/embed/src/locales/de.json');

test(
  'the default label is translated from the language attribute, with English as fallback',
  { tag: ['@core', '@embed', '@E2E-60'] },
  async ({ page, tenant }) => {
    const button = new EmbedButton(page);
    await button.goto(tenant.key, { language: 'de' });
    await expect(button.element.getByRole('button', { name: de.callUs })).toBeVisible();

    await button.goto(tenant.key, { language: 'de-CH' });
    await expect(button.element.getByRole('button', { name: de.callUs })).toBeVisible();

    await button.goto(tenant.key, { language: 'fr' });
    await expect(button.element.getByRole('button', { name: 'Call us' })).toBeVisible();

    await button.goto(tenant.key, { language: 'de', label: 'Ring the shop' });
    await expect(button.element.getByRole('button', { name: 'Ring the shop' })).toBeVisible();
  },
);
