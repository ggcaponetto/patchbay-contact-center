// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueuesCard } from './QueuesCard.tsx';
import { mocks, renderCard, resetMocks, select, toastText } from './testing.tsx';

vi.mock('../../lib/api.ts', async () => (await import('./testing.tsx')).mocks);

describe('QueuesCard', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('edits queue routing including hold music and keeps every field on save', async () => {
    renderCard(<QueuesCard />);
    expect(await screen.findByText('(support)')).toBeTruthy();
    expect(screen.getByText('vip · min 2')).toBeTruthy();
    await select('Ring order', 'Most skilled');
    await select('Hold music style', 'Calm');
    await userEvent.type(
      screen.getByLabelText(/Hold music URL for Support/),
      'https://cdn.example/loop.wav',
    );
    await userEvent.type(screen.getByLabelText('Required skills for Support'), 'lang:de{Enter}');
    // the catalogue's keys are suggested for queue requirements too
    await userEvent.click(screen.getByLabelText('Required skills for Support'));
    await userEvent.click(await screen.findByRole('option', { name: 'german-tax' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Add', exact: true })[0]!);
    expect(screen.getByText('german-tax · min 3')).toBeTruthy();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Match caller language' }));
    const relax = screen.getByLabelText(/Relax skill requirements after/) as HTMLInputElement;
    expect(relax.value).toBe('20');
    await userEvent.clear(relax);
    await userEvent.type(relax, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save routing of Support' }));
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/admin/queues/q1/config', {
        algorithm: 'most_skilled',
        requiredSkills: [
          { skill: 'vip', min: 2 },
          { skill: 'lang:de', min: 3 },
          { skill: 'german-tax', min: 3 },
        ],
        languageRouting: true,
        relaxAfterSec: 0,
        moh: 'calm',
        holdMusicUrl: 'https://cdn.example/loop.wav',
      }),
    );
    expect(toastText()).toContain('Routing of Support saved');
  }, 40_000);

  it('manages members, adds queues and deletes them with a confirmation', async () => {
    renderCard(<QueuesCard />);
    expect(await screen.findByText('(support)')).toBeTruthy();
    const card = screen.getByText('(support)').closest('.MuiPaper-root') as HTMLElement;
    const ann = within(card).getByRole('checkbox', { name: 'Ann' });
    const bob = within(card).getByRole('checkbox', { name: 'Bob' });
    expect(ann).toHaveProperty('checked', true);
    expect(bob).toHaveProperty('checked', false);
    await userEvent.click(bob);
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/admin/queues/q1/members', { userIds: ['u1', 'u2'] }),
    );
    const add = screen.getAllByRole('button', { name: 'Add' }).at(-1)!;
    expect(add).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText(/New queue/), 'sales');
    await userEvent.click(add);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/admin/queues', { key: 'sales', name: 'sales' }),
    );
    expect(toastText()).toContain('Queue sales added');

    mocks.del.mockResolvedValueOnce({ ok: true, archived: true });
    await userEvent.click(screen.getByRole('button', { name: 'delete queue Support' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/admin/queues/q1'));
    await waitFor(() => expect(toastText()).toContain('archived'));

    mocks.del.mockRejectedValueOnce(new Error('last_queue'));
    await userEvent.click(screen.getByRole('button', { name: 'delete queue Support' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    await waitFor(() => expect(toastText()).toContain('last queue cannot be deleted'));
  }, 40_000);
});
