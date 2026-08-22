/**
 * The embedded button's failure modes, all visible to the customer inline and all
 * recoverable by clicking again. No LiveKit needed: every case fails before a room exists.
 */
import { EMBED_ORIGIN } from '../../../../playwright.config.ts';
import { EmbedButton, admin, expect, test } from '../../support/fixtures.ts';

test(
  'without a key the button explains what is missing and makes no request',
  { tag: ['@core', '@embed', '@E2E-04'] },
  async ({ page }) => {
    const button = new EmbedButton(page);
    await button.goto('');
    await expect(page.getByText('No key set yet')).toBeVisible();
    const calls: string[] = [];
    page.on('request', (r) => r.url().includes('/api/public/calls') && calls.push(r.url()));
    await button.call();
    await expect(button.element).toContainText(
      'Could not start the call: the key attribute is missing (create one in Settings)',
    );
    expect(calls).toEqual([]);
  },
);

test(
  'an unknown key is rejected and the next click retries',
  { tag: ['@core', '@embed', '@E2E-05'] },
  async ({ page }) => {
    const button = new EmbedButton(page);
    await button.goto('pk_00000000000000000000000000000000');
    await button.call();
    await expect(button.element).toContainText(
      'Could not start the call: unknown_embed_key_or_queue',
    );
    const retried = page.waitForRequest((r) => r.url().includes('/api/public/calls'));
    await button.call();
    expect((await retried).method()).toBe('POST');
  },
);

test(
  'a key restricted to another origin refuses this website; the allowed origin is let through',
  { tag: ['@core', '@embed', '@E2E-06'] },
  async ({ page, supervisor, unique, call }) => {
    const api = admin(supervisor.request);
    const elsewhere = await api.createKey(unique('elsewhere'), ['https://shop.example']);
    const button = new EmbedButton(page);
    await button.goto(elsewhere.publicKey);
    await button.call();
    await expect(button.element).toContainText('Could not start the call: origin_not_allowed');

    const here = await api.createKey(unique('here'), [EMBED_ORIGIN]);
    // the allowed origin is accepted by the API (the button would now open a room)
    const created = await call(here.publicKey, { origin: EMBED_ORIGIN });
    expect(created.callId).toBeTruthy();
  },
);
