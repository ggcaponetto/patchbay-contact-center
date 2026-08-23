/**
 * Supervisor tools on a live call: silent listen-in (call status untouched) and take-over
 * (the supervisor becomes the human on the call; hanging up ends it).
 */
import { CallPage, desk, expect, test } from '../../support/fixtures.ts';

test(
  'listening in leaves the call with the AI and stopping does not end it',
  { tag: ['@core', '@supervisor', '@E2E-17'] },
  async ({ page, supervisor, tenant, call, ai }) => {
    const { callId } = await call(tenant.key);
    await ai(callId).join();
    const callPage = new CallPage(page);
    await callPage.goto(callId);
    await callPage.listenIn();
    await expect(page.getByRole('button', { name: 'Mute' })).toHaveCount(0);
    await expect(callPage.statusChip()).toHaveText('With AI');
    let detail = await desk(supervisor.request).call(callId);
    expect(detail.status).toBe('ai');
    expect(detail.events.map((e) => e.type)).toContain('listen.joined');
    expect(detail.participants.map((p) => p.kind)).toContain('supervisor');

    await callPage.stopListening();
    await expect(page.getByRole('button', { name: 'Listen in' })).toBeVisible();
    detail = await desk(supervisor.request).call(callId);
    expect(detail.status).toBe('ai');
    expect(detail.events.map((e) => e.type)).toContain('supervisor.left');
  },
);

test(
  'taking over puts the call with the supervisor and hanging up ends it',
  { tag: ['@core', '@supervisor', '@E2E-18'] },
  async ({ page, supervisor, tenant, call, ai }) => {
    const { callId } = await call(tenant.key);
    await ai(callId).join();
    const callPage = new CallPage(page);
    await callPage.goto(callId);
    await callPage.takeOver();
    await expect(callPage.statusChip()).toHaveText('With agent');
    let detail = await desk(supervisor.request).call(callId);
    expect(detail.status).toBe('human');
    expect(detail.events.map((e) => e.type)).toContain('takeover.joined');

    await callPage.hangUp();
    await expect(callPage.statusChip()).toHaveText('Ended');
    await expect(page.getByRole('button', { name: 'Take over' })).toHaveCount(0);
    detail = await desk(supervisor.request).call(callId);
    expect(detail.status).toBe('ended');
    expect(detail.events.map((e) => e.type)).toContain('human.left');
  },
);
