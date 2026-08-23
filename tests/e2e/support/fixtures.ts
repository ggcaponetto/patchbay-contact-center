/**
 * The `test` every spec imports: Playwright's, extended with
 *
 * - `supervisor`: the default dev user (`e2e@example.com`), supervisor of the bootstrapped
 *   tenant — the `page` fixture is theirs. Its context, like every actor's, carries the
 *   `cc_lng=en` cookie so the desk is English regardless of the browser locale.
 * - `actor(email)`: another signed-in person in their own browser context (closed after
 *   the test). See `actors.ts`. Invite them first, or they are "not a member".
 * - `queueAgent(email)`: invite + sign in + membership of the `support` queue, i.e. an
 *   agent the routing will ring.
 * - `tenant`: the tenant id and one embed key created for this test. On teardown every
 *   call still live in the tenant is ended (as the worker would), so the next test starts
 *   with an empty dashboard.
 * - `unique(prefix)`: a per-test unique name, so labels and queue names never collide
 *   between tests or repeated runs against the same database.
 * - `ai(callId)` / `call(...)`: shortcuts to `playAi` / `createCall` with the plain
 *   request context (no cookie: the AI and the customer are not desk users).
 *
 * Tags: every test carries one tier (`@smoke` | `@core` | `@cloud`), one area and its
 * `@E2E-nn` id from tests/e2e/TEST-PLAN.md; `npm run e2e:plan` checks that.
 */
import { test as base } from '@playwright/test';
import { E2E_USER } from '../../../playwright.config.ts';
import { type Actor, ENGLISH_COOKIE, newActor } from './actors.ts';
import { admin, createCall, desk, playAi } from './api.ts';

type Fixtures = {
  supervisor: Actor;
  actor: (email: string) => Promise<Actor>;
  queueAgent: (email: string) => Promise<Actor>;
  tenant: { id: string; key: string; keyId: string };
  unique: (prefix: string) => string;
  ai: (callId: string) => ReturnType<typeof playAi>;
  call: (
    embedKey: string,
    opts?: Parameters<typeof createCall>[2],
  ) => ReturnType<typeof createCall>;
};

export const test = base.extend<Fixtures>({
  supervisor: async ({ context, page }, use) => {
    await context.addCookies([ENGLISH_COOKIE]);
    await use({
      email: E2E_USER,
      name: 'e2e',
      context,
      page,
      request: context.request,
      close: async () => undefined,
    });
  },
  actor: async ({ browser }, use) => {
    const actors: Actor[] = [];
    await use(async (email) => {
      const a = await newActor(browser, email);
      actors.push(a);
      return a;
    });
    await Promise.all(actors.map((a) => a.close()));
  },
  queueAgent: async ({ supervisor, actor }, use) => {
    await use(async (email) => {
      const api = admin(supervisor.request);
      await api.invite(email);
      const agent = await actor(email);
      const me = await desk(agent.request).me();
      const support = (await api.queues()).find((q) => q.key === 'support')!;
      await api.setQueueMembers(support.id, [...support.memberIds, me.user.id]);
      return agent;
    });
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures must destructure
  unique: async ({}, use, testInfo) => {
    let n = 0;
    const run = Date.now().toString(36).slice(-4);
    await use((prefix) => `${prefix}-${testInfo.testId.slice(0, 6)}${run}-${++n}`);
  },
  tenant: async ({ supervisor, unique }, use) => {
    const api = admin(supervisor.request);
    const me = await desk(supervisor.request).me();
    const key = await api.createKey(unique('key'));
    await use({ id: me.memberships[0]!.tenantId, key: key.publicKey, keyId: key.id });
    const live = (await desk(supervisor.request).calls()).filter((c) => c.status !== 'ended');
    await Promise.all(live.map((c) => playAi(supervisor.request, c.id).end()));
  },
  ai: async ({ request }, use) => {
    await use((callId) => playAi(request, callId));
  },
  call: async ({ request }, use) => {
    await use((embedKey, opts) => createCall(request, embedKey, opts));
  },
});

export { expect } from '@playwright/test';
export { admin, desk } from './api.ts';
export * from './pages.ts';
