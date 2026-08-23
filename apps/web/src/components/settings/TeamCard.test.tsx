// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamCard } from './TeamCard.tsx';
import { mocks, renderCard, resetMocks, toastText } from './testing.tsx';

vi.mock('../../lib/api.ts', async () => (await import('./testing.tsx')).mocks);

describe('TeamCard', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('lists the team and sends invites with feedback', async () => {
    renderCard(<TeamCard />);
    expect(await screen.findByText('ann@x')).toBeTruthy();
    expect(screen.getByText('new@x')).toBeTruthy();
    expect(screen.queryByText('old@x')).toBeNull();
    expect(screen.getByText('invited as agent')).toBeTruthy();
    const invite = screen.getByRole('button', { name: 'Invite' });
    expect(invite).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText(/Invite by Google email/), 'carl@x');
    const row = screen.getByLabelText(/Invite by Google email/).closest('.MuiStack-root')!;
    await userEvent.click(within(row as HTMLElement).getByRole('combobox'));
    await userEvent.click(await screen.findByRole('option', { name: 'supervisor' }));
    await userEvent.click(invite);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/admin/invites', {
        email: 'carl@x',
        role: 'supervisor',
      }),
    );
    expect(toastText()).toContain('carl@x invited');
    await waitFor(() =>
      expect(screen.getByLabelText(/Invite by Google email/)).toHaveProperty('value', ''),
    );
    mocks.post.mockRejectedValueOnce(new Error('already_member'));
    await userEvent.type(screen.getByLabelText(/Invite by Google email/), 'ann@x');
    await userEvent.click(invite);
    await waitFor(() => expect(toastText()).toContain('already_member'));
  }, 40_000);

  it('edits member skills as chips and saves them', async () => {
    renderCard(<TeamCard />);
    // Ann's skills come from the API; queue requirements are suggested
    expect(await screen.findByText('billing · level 2')).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Save skills of Ann' });
    expect(save).toHaveProperty('disabled', true);
    const input = screen.getByLabelText('Add a skill to Ann');
    await userEvent.click(input);
    await userEvent.click(await screen.findByRole('option', { name: 'vip' }));
    await userEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]!);
    expect(screen.getByText('vip · level 3')).toBeTruthy();
    // re-adding a skill replaces its level; Enter adds too
    await userEvent.type(input, 'Billing');
    const level = screen.getAllByLabelText('Level')[0]!;
    await userEvent.click(level);
    await userEvent.click(await screen.findByRole('option', { name: '5' }));
    await userEvent.type(input, '{Enter}');
    expect(screen.getByText('billing · level 5')).toBeTruthy();
    expect(screen.queryByText('billing · level 2')).toBeNull();
    // the chip's ✕ removes
    await userEvent.click(screen.getByText('vip · level 3').parentElement!.querySelector('svg')!);
    await userEvent.click(save);
    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('/admin/members/u1/skills', {
        skills: [{ skill: 'billing', proficiency: 5 }],
      }),
    );
    expect(toastText()).toContain('Skills of Ann saved');
  }, 40_000);
});
