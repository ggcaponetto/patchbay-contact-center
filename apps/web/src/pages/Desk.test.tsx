// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { type DeskState, initialState } from '../lib/store.ts';
import { Desk } from './Desk.tsx';

const post = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() =>
  vi.fn(async () => ({ customerMeta: {}, language: null, priority: 0, participants: [] })),
);
vi.mock('../lib/api.ts', () => ({ post, api }));
// Sounds are tested in lib/sounds.test.ts; here only the wiring matters.
const ring = vi.hoisted(() => vi.fn());
vi.mock('../lib/sounds.ts', () => ({ useRingtone: ring, zipTone: vi.fn() }));
// The state bar has its own tests (StateBar.test.tsx); here it only needs to render.
vi.mock('../components/StateBar.tsx', () => ({
  StateBar: ({ me }: { me?: { state: string } }) => <span>state:{me?.state ?? 'offline'}</span>,
}));
// The real panel needs a LiveKit room; a stub exposing `onLeave` is enough here.
vi.mock('../components/CallPanel.tsx', () => ({
  CallPanel: ({
    title,
    onLeave,
    hold,
    labelFor,
  }: {
    title: string;
    onLeave: () => void;
    hold?: { heldAt: string | null | undefined; onToggle: () => void };
    labelFor?: (s: { identity: string; speaker: string }) => string;
  }) => (
    <div>
      <span>{title}</span>
      <span>held:{String(hold?.heldAt)}</span>
      <span>{labelFor?.({ identity: 'human:u2', speaker: 'human' })}</span>
      <button onClick={onLeave}>Leave</button>
      <button onClick={hold?.onToggle}>Toggle hold</button>
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
    const { rerender } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Desk desk={fakeDesk(mine('not_ready'))} me={me} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('state:not_ready')).toBeTruthy();
    expect(screen.getByText(/Set yourself to Ready/)).toBeTruthy();
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Desk desk={fakeDesk(mine('ready'))} me={me} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Waiting for calls/)).toBeTruthy();
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Desk desk={fakeDesk({})} me={me} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('state:offline')).toBeTruthy();
  });

  it('ignores Accept once the offer is gone', async () => {
    const desk = fakeDesk({ offer });
    const { rerender } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Desk desk={desk} me={me} />
      </QueryClientProvider>,
    );
    // The dialog is still mounted while its exit transition runs; a click must be a no-op.
    rerender(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Desk desk={fakeDesk({})} me={me} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByText('Accept'));
    expect(post).not.toHaveBeenCalled();
  });

  it('declines an offer', async () => {
    const desk = fakeDesk({ offer });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Desk desk={desk} me={me} />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Incoming call · support/)).toBeTruthy();
    // the offer rings (with the tenant's ringtone once the settings are known)
    expect(ring).toHaveBeenLastCalledWith(true, undefined);
    expect(screen.getByRole('dialog').getAttribute('data-ringing')).toBe('true');
    expect(screen.getByText('refund')).toBeTruthy();
    expect(screen.getByText('angry')).toBeTruthy();
    expect(screen.getByText(/\d+s to answer/)).toBeTruthy();
    await userEvent.click(screen.getByText('Decline'));
    expect(desk.send).toHaveBeenCalledWith({ type: 'offer.decline', callId: 'c1' });
    expect(desk.dispatch).toHaveBeenCalledWith({ type: 'offer.clear' });
  });

  it('shows the routing chips of an attribute-routed offer', async () => {
    // the settings fetch (same mock): the catalogue labels the skill keys
    api.mockImplementation(async (path: string) =>
      path === '/desk/settings'
        ? { skills: [{ key: 'vip', label: 'VIP customers' }] }
        : { customerMeta: {}, language: null, priority: 0, participants: [] },
    );
    const desk = fakeDesk({
      offer: { ...offer, requiredSkills: ['vip', 'billing'], language: 'it', relaxed: true },
    });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Desk desk={desk} me={me} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('VIP customers')).toBeTruthy();
    expect(screen.getByText('billing')).toBeTruthy();
    expect(screen.getByText('Language: Italiano')).toBeTruthy();
    expect(screen.getByText('Requirements relaxed')).toBeTruthy();
  });

  it('accepts an offer, shows the call and leaves', async () => {
    post.mockResolvedValueOnce({ token: 'tok', url: 'wss://lk' }).mockResolvedValueOnce({});
    const desk = fakeDesk({ offer, transcripts: {} });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Desk desk={desk} me={me} />
      </QueryClientProvider>,
    );
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

  it('takes the hold state from the socket, falling back to the fetched call', async () => {
    post.mockResolvedValue({ token: 'tok', url: 'wss://lk' });
    api.mockResolvedValue({
      customerMeta: {},
      language: null,
      priority: 0,
      heldAt: '2026-01-01T00:00:00Z',
      participants: [],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const agents = [{ ...mine('busy').agents[0]!, userId: 'u2', name: 'Bob' }];
    const view = (state: Partial<DeskState>) => (
      <QueryClientProvider client={client}>
        <Desk desk={fakeDesk({ offer, agents, ...state })} me={me} />
      </QueryClientProvider>
    );
    const { rerender } = render(view({}));
    await userEvent.click(screen.getByText('Accept'));
    // the detail says held; the socket has not spoken yet
    expect(await screen.findByText('held:2026-01-01T00:00:00Z')).toBeTruthy();
    expect(screen.getByText('Bob · Agent')).toBeTruthy();
    // Retrieve posts /retrieve; the socket frame then wins over the (stale) detail
    await userEvent.click(screen.getByText('Toggle hold'));
    expect(post).toHaveBeenLastCalledWith('/desk/calls/c1/retrieve');
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    rerender(view({ held: { c1: null }, callsVersion: 1 }));
    expect(screen.getByText('held:null')).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['call', 'c1'] });
    await userEvent.click(screen.getByText('Toggle hold'));
    expect(post).toHaveBeenLastCalledWith('/desk/calls/c1/hold');
    rerender(view({ held: { c1: '2026-01-01T00:05:00Z' }, callsVersion: 2 }));
    expect(screen.getByText('held:2026-01-01T00:05:00Z')).toBeTruthy();
    // a failing hold request is reported
    post.mockRejectedValueOnce(new Error('not_held'));
    await userEvent.click(screen.getByText('Toggle hold'));
    expect(await screen.findByText('not_held')).toBeTruthy();
  });

  it('ignores a failing leave call', async () => {
    post
      .mockResolvedValueOnce({ token: 'tok', url: 'wss://lk' })
      .mockRejectedValueOnce(new Error('x'));
    const desk = fakeDesk({ offer });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Desk desk={desk} me={me} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByText('Accept'));
    await userEvent.click(await screen.findByText('Leave'));
    await act(async () => {});
    expect(screen.queryByText('Customer call')).toBeNull();
  });

  it('reports a failed accept and clears the offer', async () => {
    post.mockRejectedValueOnce(new Error('not_ringing_you'));
    const desk = fakeDesk({ offer });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <Desk desk={desk} me={me} />
      </QueryClientProvider>,
    );
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
