/**
 * The embed demo page as served by `npm run dev:embed`: with no `api` attribute the button
 * calls the page's own origin, and the dev server proxies `/api` to the API. This is what
 * makes the demo work when only the page's port is reachable (a Codespace, a tunnel).
 */
import { EMBED_ORIGIN } from '../../../../playwright.config.ts';
import { EmbedButton, expect, test } from '../../support/fixtures.ts';

test(
  'without an api attribute the button calls its own origin, proxied to the API',
  { tag: ['@core', '@embed', '@E2E-64'] },
  async ({ page }) => {
    const button = new EmbedButton(page);
    await button.goto('pk_00000000000000000000000000000000', { api: '' });
    const sent = page.waitForRequest((r) => r.url().includes('/api/public/calls'));
    await button.call();
    expect((await sent).url()).toBe(`${EMBED_ORIGIN}/api/public/calls`);
    // The API answered through the proxy: its error code, not a network failure.
    await expect(button.element).toContainText(
      'Could not start the call: unknown_embed_key_or_queue',
    );
  },
);
