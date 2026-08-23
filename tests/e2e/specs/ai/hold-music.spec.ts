/**
 * The real hold music: the agent puts the customer on hold, the media worker (started by
 * global-setup.ts) joins the room and publishes the loop — visible on the desk as a
 * `media` participant — and leaves again on retrieve.
 */
import { HAS_CLOUD } from '../../../../playwright.config.ts';
import { DeskPage, EmbedButton, desk, expect, test } from '../../support/fixtures.ts';

test.skip(!HAS_CLOUD, 'needs LiveKit Cloud credentials');

test(
  'the media worker joins with hold music and leaves on retrieve',
  { tag: ['@cloud', '@ai', '@desk', '@E2E-40'] },
  async ({ page, context, supervisor, tenant, ai }) => {
    const deskPage = new DeskPage(page);
    await deskPage.goto();
    await deskPage.setReady();

    const button = new EmbedButton(await context.newPage());
    await button.goto(tenant.key);
    await button.call();
    await expect(button.element).toContainText('AI assistant', { timeout: 45_000 });
    const [callRow] = await desk(supervisor.request).calls();
    const callId = callRow!.id;
    const outcome = ai(callId).escalate();
    await deskPage.expectRinging();
    await deskPage.accept();
    await outcome;

    await page.getByRole('button', { name: 'Hold' }).click();
    // the media participant shows up as a peer chip on the agent's panel
    await expect(page.getByText('media: Music')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /Retrieve/ }).click();
    await expect(page.getByText('media: Music')).toHaveCount(0, { timeout: 30_000 });
    await deskPage.hangUp();
  },
);
