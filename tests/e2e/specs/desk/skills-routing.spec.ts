/**
 * Skills-based routing: a queue that requires a skill never rings unqualified agents;
 * granting the skill (reskilling on the fly) makes the very next call ring them.
 */
import { DeskPage, admin, expect, test } from '../../support/fixtures.ts';

test(
  'a skill requirement filters the ring and reskilling lifts it',
  { tag: ['@core', '@desk', '@E2E-49'] },
  async ({ supervisor, queueAgent, unique, tenant, call, ai }) => {
    const alice = await queueAgent(`${unique('alice')}@example.com`);
    const aliceDesk = new DeskPage(alice.page);
    await aliceDesk.goto();
    await aliceDesk.setReady();

    const a = admin(supervisor.request);
    const queues = await a.queues();
    const support = queues.find((q) => q.key === 'support')!;
    await a.setQueueConfig(support.id, {
      algorithm: 'longest_idle',
      requiredSkills: [{ skill: 'vip', min: 2 }],
      languageRouting: false,
    });

    // Alice holds no `vip` skill: the escalation finds nobody and never rings her.
    const first = await call(tenant.key);
    const agent1 = ai(first.callId);
    await agent1.join();
    const miss = await agent1.escalate();
    expect(miss.outcome).toBe('nobody');
    await expect(alice.page.getByRole('dialog')).toHaveCount(0);

    // Reskilling applies to the next routing decision: now she rings.
    const members = await a.members();
    const aliceId = members.find((m) => m.email === alice.email)!.userId;
    await a.setSkills(aliceId, [{ skill: 'vip', proficiency: 3 }]);
    const second = await call(tenant.key);
    const agent2 = ai(second.callId);
    await agent2.join();
    const outcome = agent2.escalate();
    await aliceDesk.expectRinging();
    await aliceDesk.accept();
    expect((await outcome).outcome).toBe('accepted');

    // clean up the requirement for later specs sharing the tenant
    await a.setQueueConfig(support.id, {
      algorithm: 'longest_idle',
      requiredSkills: [],
      languageRouting: false,
    });
  },
);
