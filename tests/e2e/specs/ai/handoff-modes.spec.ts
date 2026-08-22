/**
 * The real handoff: the AI is on the call, escalates (triggered through the internal API
 * because the fake microphone cannot ask for a person), the supervisor accepts and joins
 * the same room, and the worker reacts according to the tenant's handoff mode —
 * `leave` (becomes a transcriber) or `listen` (stays muted). Needs `LIVEKIT_*`.
 */
import { HAS_CLOUD } from '../../../../playwright.config.ts';
import { DeskPage, EmbedButton, admin, desk, expect, test } from '../../support/fixtures.ts';

test.skip(!HAS_CLOUD, 'needs LiveKit Cloud credentials');

test.afterEach(async ({ supervisor }) => {
  await admin(supervisor.request).updateSettings({ handoff: { aiBehavior: 'leave' } });
});

for (const behavior of ['leave', 'listen'] as const) {
  test(
    `handoff "${behavior}": the supervisor takes the call over from the AI in the same room`,
    { tag: ['@cloud', '@ai', '@desk', behavior === 'leave' ? '@E2E-27' : '@E2E-28'] },
    async ({ page, context, supervisor, tenant, ai }) => {
      await admin(supervisor.request).updateSettings({ handoff: { aiBehavior: behavior } });
      const deskPage = new DeskPage(page);
      await deskPage.goto();
      await deskPage.setAvailable();

      const button = new EmbedButton(await context.newPage());
      await button.goto(tenant.key);
      await button.call();
      await expect(button.element).toContainText('AI assistant', { timeout: 45_000 });
      const [callRow] = await desk(supervisor.request).calls();
      const callId = callRow!.id;

      const outcome = ai(callId).escalate('e2e', 'Caller wants a person.');
      await deskPage.expectRinging();
      await deskPage.accept();
      expect(await outcome).toEqual({ outcome: 'accepted', agentName: 'e2e' });
      await expect(button.element).toContainText('Agent', { timeout: 30_000 });
      await expect
        .poll(
          async () =>
            (await desk(supervisor.request).call(callId)).events.find((e) => e.type === 'handoff')
              ?.payload,
          { timeout: 30_000 },
        )
        .toMatchObject({ behavior });
      expect((await desk(supervisor.request).call(callId)).status).toBe('human');
      if (behavior === 'leave') {
        // the worker closes its session and re-registers as the transcriber right after
        await expect
          .poll(
            async () =>
              (await desk(supervisor.request).call(callId)).participants.map((p) => p.kind),
            { timeout: 30_000 },
          )
          .toContain('transcriber');
      }

      await deskPage.hangUp();
      await expect(button.element).toContainText('Call ended', { timeout: 30_000 });
      await expect
        .poll(async () => (await desk(supervisor.request).call(callId)).status)
        .toBe('ended');
    },
  );
}
