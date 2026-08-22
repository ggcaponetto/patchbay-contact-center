// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { type DeskState, initialState } from '../lib/store.ts';
import { Desk } from './Desk.tsx';

const post = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.ts', () => ({ post }));
// The state bar has its own tests (StateBar.test.tsx); here it only needs to render.
vi.mock('../components/StateBar.tsx', () => ({
  StateBar: ({ me }: { me?: { state: string } }) => <span>state:{me?.state ?? 'offline'}</span>,
}));
// The real panel needs a LiveKit room; a stub exposing `onLeave` is enough here.
vi.mock('../components/CallPanel.tsx', () => ({
  CallPanel: ({ title, onLeave }: { title: string; onLeave: () => void }) => (
    <div>
      <span>{title}</span>
      <button onClick={onLeave}>Leave</button>
    </div>
  ),
}));

const me: Me = {
  user: { id: 'u1', email: 'a@x', name: 'Ann' },
  isAdmin: false,
  memberships: [{ tenantId: 't', role: 'agent', tenantName: 'T' }],
};

/** Desk prop with spies for everything the page can call. */
const fakeDesk = (state: Partial<DeskState>): ReturnType<typeof useDeskSocket> => ({
  state: { ...initialState, ...state },
  dispatch: vi.fn(),
  send: vi.fn(),
});

/** A presence frame where Ann is in `state`. */
const mine = (state: 'ready' | 'not_ready' | 'busy' | 'acw') => ({
  agents: [
    {
      userId: 'u1',
      name: 'Ann',
      state,
      reason: null,
      since: '2026-01-01T00:00:00Z',
      callId: null,
      acwUntil: null,
    },
  ],
});

const offer = {
  callId: 'c1',
  queueKey: 'support',
  reason: 'refund',
  summary: 'angry',
  expiresAt: new Date(Date.now() + 15_000).toISOString(),
};

describe('Desk', () => {
  beforeEach(() => post.mockReset());
  afterEach(cleanup);

  it('shows the state bar with my presence and the matching hint', () => {
    const { rerender } = render(<Desk desk={fakeDesk(mine('not_ready'))} me={me} />);
    expect(screen.getByText('state:not_ready')).toBeTruthy();
    expect(screen.getByText(/Set yourself to Ready/)).toBeTruthy();
    rerender(<Desk desk={fakeDesk(mine('ready'))} me={me} />);
    expect(screen.getByText(/Waiting for calls/)).toBeTruthy();
    rerender(<Desk desk={fakeDesk({})} me={me} />);
    expect(screen.getByText('state:offline')).toBeTruthy();
  });

  it('ignores Accept once the offer is gone', async () => {
    const desk = fakeDesk({ offer });
    const { rerender } = render(<Desk desk={desk} me={me} />);
    // The dialog is still mounted while its exit transition runs; a click must be a no-op.
    rerender(<Desk desk={fakeDesk({})} me={me} />);
    await userEvent.click(screen.getByText('Accept'));
    expect(post).not.toHaveBeenCalled();
  });

  it('declines an offer', async () => {
    const desk = fakeDesk({ offer });
    render(<Desk desk={desk} me={me} />);
    expect(screen.getByText(/Incoming call · support/)).toBeTruthy();
    expect(screen.getByText('refund')).toBeTruthy();
    expect(screen.getByText('angry')).toBeTruthy();
    expect(screen.getByText(/\d+s to answer/)).toBeTruthy();
    await userEvent.click(screen.getByText('Decline'));
    expect(desk.send).toHaveBeenCalledWith({ type: 'offer.decline', callId: 'c1' });
    expect(desk.dispatch).toHaveBeenCalledWith({ type: 'offer.clear' });
  });

  it('accepts an offer, shows the call and leaves', async () => {
    post.mockResolvedValueOnce({ token: 'tok', url: 'wss://lk' }).mockResolvedValueOnce({});
    const desk = fakeDesk({ offer, transcripts: {} });
    render(<Desk desk={desk} me={me} />);
    await userEvent.click(screen.getByText('Accept'));
    expect(post).toHaveBeenCalledWith('/desk/calls/c1/accept');
    expect(desk.send).toHaveBeenCalledWith({ type: 'subscribe', callId: 'c1' });
    expect(desk.dispatch).toHaveBeenCalledWith({ type: 'offer.clear' });
    expect(await screen.findByText('Customer call')).toBeTruthy();

    await userEvent.click(screen.getByText('Leave'));
    await act(async () => {});
    expect(post).toHaveBeenLastCalledWith('/desk/calls/c1/leave', { role: 'human' });
    expect(screen.queryByText('Customer call')).toBeNull();
  });

  it('ignores a failing leave call', async () => {
    post
      .mockResolvedValueOnce({ token: 'tok', url: 'wss://lk' })
      .mockRejectedValueOnce(new Error('x'));
    const desk = fakeDesk({ offer });
    render(<Desk desk={desk} me={me} />);
    await userEvent.click(screen.getByText('Accept'));
    await userEvent.click(await screen.findByText('Leave'));
    await act(async () => {});
    expect(screen.queryByText('Customer call')).toBeNull();
  });

  it('reports a failed accept and clears the offer', async () => {
    post.mockRejectedValueOnce(new Error('not_ringing_you'));
    const desk = fakeDesk({ offer });
    render(<Desk desk={desk} me={me} />);
    await userEvent.click(screen.getByText('Accept'));
    expect(await screen.findByText('Could not accept: not_ringing_you')).toBeTruthy();
    expect(desk.dispatch).toHaveBeenCalledWith({ type: 'offer.clear' });
    await userEvent.click(screen.getByRole('button', { name: 'Close', hidden: true }));
    expect(screen.queryByText(/Could not accept/)).toBeNull();

    post.mockRejectedValueOnce('boom');
    await userEvent.click(screen.getByText('Accept'));
    expect(await screen.findByText('Could not accept: boom')).toBeTruthy();
  });
});
