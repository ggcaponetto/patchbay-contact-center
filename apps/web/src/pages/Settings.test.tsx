// @vitest-environment jsdom
import { defaultTenantSettings } from '@cc/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from './Settings.tsx';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
}));
vi.mock('../lib/api.ts', () => mocks);

/** Canned responses per `GET /api/admin/*` path. */
const data: Record<string, unknown> = {
  '/admin/tenant': { id: 't', name: 'Acme', slug: 'acme', settings: defaultTenantSettings() },
  '/admin/members': [
    { userId: 'u1', name: 'Ann', email: 'ann@x', role: 'supervisor' },
    { userId: 'u2', name: 'Bob', email: 'bob@x', role: 'agent' },
  ],
  '/admin/invites': [
    { id: 'i1', email: 'new@x', role: 'agent', acceptedAt: null },
    { id: 'i2', email: 'old@x', role: 'agent', acceptedAt: '2026-01-01T00:00:00Z' },
  ],
  '/admin/queues': [{ id: 'q1', key: 'support', name: 'Support', memberIds: ['u1'], config: {} }],
  '/admin/members/u1/skills': [{ skill: 'billing', proficiency: 2 }],
  '/admin/members/u2/skills': [],
  '/admin/embed-keys': [
    { id: 'k1', label: 'Shop', publicKey: 'pk_1', allowedOrigins: ['https://shop'] },
    { id: 'k2', label: 'Blog', publicKey: 'pk_2', allowedOrigins: [] },
  ],
};

const renderSettings = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Settings />
    </QueryClientProvider>,
  );

/** Picks an option of a MUI select opened from the element labelled `label`. */
const select = async (label: string | RegExp, option: string | RegExp) => {
  await userEvent.click(screen.getByLabelText(label));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};

describe('Settings', () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.api.mockImplementation((path: string) => Promise.resolve(data[path]));
    for (const m of [mocks.post, mocks.patch, mocks.put, mocks.del]) m.mockResolvedValue({});
  });
  afterEach(cleanup);

  it('edits and saves routing settings, showing save errors', async () => {
    renderSettings();
    await screen.findByText('Routing & AI');
    await select(/Who answers first/, /Ring humans first/);
    await select(/When a human takes over/, /stays muted/);
    await userEvent.clear(screen.getByLabelText(/Ring each agent for/));
    await userEvent.type(screen.getByLabelText(/Ring each agent for/), '45');
    await userEvent.clear(screen.getByLabelText(/Human-first timeout/));
    await userEvent.type(screen.getByLabelText(/Human-first timeout/), '60');
    await userEvent.clear(screen.getByLabelText(/Wrap-up time/));
    await userEvent.type(screen.getByLabelText(/Wrap-up time/), '15');
    await userEvent.clear(screen.getByLabelText(/Not-ready reason codes/));
    await userEvent.type(screen.getByLabelText(/Not-ready reason codes/), 'Break, Coffee');
    await userEvent.clear(screen.getByLabelText(/AI greeting instruction/));
    await userEvent.type(screen.getByLabelText(/AI greeting instruction/), 'Say hi');
    await userEvent.type(screen.getByLabelText(/Company instructions/), 'Be nice');
    await userEvent.click(screen.getByText('Save'));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/admin/tenant/settings', {
        routingMode: 'human-first',
        handoff: { aiBehavior: 'listen' },
        offerTimeoutSec: 45,
        humanFirstTimeoutSec: 60,
        acwSec: 15,
        holdReminderSec: 60,
        autoAnswer: false,
        monitorNotify: true,
        ticker: '',
        hours: {
          mode: 'off',
          timezone: 'UTC',
          open: [],
          holidays: [],
          closedMessage: 'We are currently closed. Please call again during business hours.',
          emergencyMessage: 'We are currently unable to take calls. Please try again later.',
        },
        alerts: { maxWaiting: 0, maxWaitSec: 0, maxCallSec: 0 },
        dispositions: [],
        dispositionRequired: false,
        notReadyReasons: ['Break', 'Coffee'],
        aiAgent: { greeting: 'Say hi', instructions: 'Be nice' },
      }),
    );

    mocks.patch.mockRejectedValueOnce(new Error('invalid_settings'));
    await userEvent.click(screen.getByText('Save'));
    expect(await screen.findByText('Error: invalid_settings')).toBeTruthy();
  }, 40_000); // the settings page grew card by card; instrumented typing is slow

  it('lists the team and sends invites', async () => {
    renderSettings();
    expect(await screen.findByText('ann@x')).toBeTruthy();
    expect(screen.getByText('new@x')).toBeTruthy();
    expect(screen.queryByText('old@x')).toBeNull();
    expect(screen.getByText('invited as agent')).toBeTruthy();
    const invite = screen.getByRole('button', { name: 'Invite' });
    expect(invite).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText(/Invite by Google email/), 'carl@x');
    const card = screen.getByText('Team').parentElement!;
    await userEvent.click(within(card).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'supervisor' }));
    await userEvent.click(invite);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/admin/invites', {
        email: 'carl@x',
        role: 'supervisor',
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText(/Invite by Google email/)).toHaveProperty('value', ''),
    );
  }, 40_000);

  it('edits and saves the business hours', async () => {
    renderSettings();
    await screen.findByText('Business hours');
    await select('Mode', 'Follow the schedule');
    const tz = screen.getByLabelText('Timezone (IANA)');
    await userEvent.clear(tz);
    await userEvent.type(tz, 'Europe/Zurich');
    // malformed lines are dropped, day names map to dow numbers
    await userEvent.type(
      screen.getByLabelText(/Weekly windows/),
      'mon 09:00-17:00{Enter}bogus{Enter}tue 08:30-12:00',
    );
    await userEvent.type(screen.getByLabelText(/Holidays/), '2026-12-25{Enter}nope');
    const closedMsg = screen.getByLabelText('Closed message');
    await userEvent.clear(closedMsg);
    await userEvent.type(closedMsg, 'Closed.');
    const emergencyMsg = screen.getByLabelText('Emergency message');
    await userEvent.clear(emergencyMsg);
    await userEvent.type(emergencyMsg, 'Emergency.');
    await userEvent.click(screen.getByRole('button', { name: 'Save hours' }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/admin/tenant/settings', {
        hours: {
          mode: 'auto',
          timezone: 'Europe/Zurich',
          open: [
            { dow: 1, from: '09:00', to: '17:00' },
            { dow: 2, from: '08:30', to: '12:00' },
          ],
          holidays: ['2026-12-25'],
          closedMessage: 'Closed.',
          emergencyMessage: 'Emergency.',
        },
      }),
    );
  }, 40_000);

  it('edits queue routing and member skills', async () => {
    renderSettings();
    expect(await screen.findByText('(support)')).toBeTruthy();
    // queue routing: algorithm, parsed skill requirements, language toggle
    await select('Ring order', 'Most skilled');
    const req = screen.getByLabelText(/Required skills for Support/);
    await userEvent.type(req, 'billing=3, vip, broken=9');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Match caller language' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save routing' }));
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/admin/queues/q1/config', {
        algorithm: 'most_skilled',
        requiredSkills: [
          { skill: 'billing', min: 3 },
          { skill: 'vip', min: 1 }, // no level = 1
          { skill: 'broken', min: 5 }, // levels clamp to 1-5
        ],
        languageRouting: true,
      }),
    );

    // member skills prefill from the API and save the parsed list
    const ann = await screen.findByLabelText('Skills of Ann (skill=level, ...)');
    expect((ann as HTMLInputElement).value).toBe('billing=2');
    await userEvent.clear(ann);
    await userEvent.type(ann, 'lang:de=4');
    await userEvent.click(
      within(ann.closest('div')!.parentElement!.parentElement!).getByRole('button', {
        name: 'Save skills',
      }),
    );
    await waitFor(() =>
      expect(mocks.put).toHaveBeenLastCalledWith('/admin/members/u1/skills', {
        skills: [{ skill: 'lang:de', proficiency: 4 }],
      }),
    );
  });

  it('manages queues and their members', async () => {
    renderSettings();
    expect(await screen.findByText('(support)')).toBeTruthy();
    const card = screen.getByText('Queues').parentElement!;
    // the first checkbox is now the queue's "Match caller language" toggle
    const ann = within(card).getByRole('checkbox', { name: 'Ann' });
    const bob = within(card).getByRole('checkbox', { name: 'Bob' });
    expect(ann).toHaveProperty('checked', true);
    expect(bob).toHaveProperty('checked', false);
    await userEvent.click(bob!);
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/admin/queues/q1/members', { userIds: ['u1', 'u2'] }),
    );
    await userEvent.click(ann!);
    await waitFor(() =>
      expect(mocks.put).toHaveBeenLastCalledWith('/admin/queues/q1/members', { userIds: [] }),
    );
    const add = screen.getByRole('button', { name: 'Add' });
    expect(add).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText(/New queue/), 'sales');
    await userEvent.click(add);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/admin/queues', { key: 'sales', name: 'sales' }),
    );
    await waitFor(() => expect(screen.getByLabelText(/New queue/)).toHaveProperty('value', ''));
  });

  it('shows embed keys with snippets, creates and deletes keys', async () => {
    renderSettings();
    expect(await screen.findByText('https://shop')).toBeTruthy();
    expect(screen.getByText('any origin')).toBeTruthy();
    const snippets = screen.getAllByLabelText(/Embed snippet/) as HTMLTextAreaElement[];
    expect(snippets[0]?.value).toContain(`<script src="${location.origin}/embed/call-button.js">`);
    expect(snippets[0]?.value).toContain('key="pk_1" queue="support"');
    await userEvent.click(screen.getAllByRole('button', { name: /^delete / })[1]!);
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/admin/embed-keys/k2'));

    const create = screen.getByRole('button', { name: 'Create key' });
    expect(create).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText(/^Label/), 'Docs');
    await userEvent.type(
      screen.getByLabelText(/Allowed origins/),
      'https://a.example, https://b.example',
    );
    await userEvent.click(create);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/admin/embed-keys', {
        label: 'Docs',
        allowedOrigins: ['https://a.example', 'https://b.example'],
      }),
    );
    await waitFor(() => expect(screen.getByLabelText(/^Label/)).toHaveProperty('value', ''));
  });

  it('falls back to the support queue in the snippet when no queue exists', async () => {
    mocks.api.mockImplementation((path: string) =>
      Promise.resolve(path === '/admin/queues' ? [] : data[path]),
    );
    renderSettings();
    const snippet = (await screen.findAllByLabelText(/Embed snippet/))[0] as HTMLTextAreaElement;
    expect(snippet.value).toContain('queue="support"');
  });
});
