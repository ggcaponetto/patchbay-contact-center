/**
 * Embed keys: created with a ready-to-paste snippet, deleted again, and a deleted key
 * can no longer start calls.
 */
import { API_ORIGIN } from '../../../../playwright.config.ts';
import { SettingsPage, expect, test } from '../../support/fixtures.ts';

test(
  'settings lets a supervisor create an embed key with a snippet',
  { tag: ['@smoke', '@settings', '@E2E-03'] },
  async ({ page, unique }) => {
    const settings = new SettingsPage(page);
    await settings.goto();
    const label = unique('key');
    await settings.createKey(label);
    const key = await settings.keyOf(label);
    expect(key).toMatch(/^pk_[a-f0-9]{32}$/);
    const card = settings.keyCard(label);
    // the snippet points at the desk's own origin, which serves (or proxies) the API
    await expect(card.getByLabel('Embed snippet')).toHaveValue(
      /<script src="http:\/\/localhost:3100\/embed\/call-button.js"><\/script>/,
    );
    await expect(card.getByLabel('Embed snippet')).toHaveValue(new RegExp(`key="${key}"`));
    await expect(card).toContainText('any origin');
  },
);

test(
  'deleting an embed key removes it and calls with it fail',
  { tag: ['@core', '@settings', '@E2E-23'] },
  async ({ page, request, unique }) => {
    const settings = new SettingsPage(page);
    await settings.goto();
    const label = unique('key');
    await settings.createKey(label, 'https://shop.example');
    const key = await settings.keyOf(label);
    await expect(settings.keyCard(label)).toContainText('https://shop.example');
    await settings.deleteKey(label);
    const res = await request.post(`${API_ORIGIN}/api/public/calls`, {
      headers: { origin: 'https://shop.example' },
      data: { embedKey: key },
    });
    expect(res.status()).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_embed_key_or_queue' });
  },
);
