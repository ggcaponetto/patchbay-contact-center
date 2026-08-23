// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallSummary } from '../lib/api.ts';
import type { useDeskSocket } from '../lib/hooks.ts';
import { type DeskState, initialState } from '../lib/store.ts';
import { Dashboard } from './Dashboard.tsx';

const api = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
const put = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.ts', () => ({ api, post, put }));

const fakeDesk = (state: Partial<DeskState>): ReturnType<typeof useDeskSocket> => ({
  state: { ...initialState, ...state },
  dispatch: vi.fn(),
  send: vi.fn(),
  setStatus: vi.fn(),
});

const calls: CallSummary[] = [
  {
    id: 'c1',
    status: 'ai',
    queueKey: 'support',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    aiSummary: null,
    customerMeta: { page: 'https://shop/x' },
  },
  {
    id: 'c2',
    status: 'human',
    queueKey: 'sales',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    aiSummary: null,
    customerMeta: {},
  },
  {
    id: 'c3',
    status: 'ended',
    queueKey: 'sales',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:01:00Z',
    aiSummary: 'done',
    customerMeta: {},
  },
];

const renderPage = (desk: ReturnType<typeof useDeskSocket>) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Dashboard desk={desk} />
    </QueryClientProvider>,
  );

describe('Dashboard', () => {
  beforeEach(() => {
    api.mockReset();
    location.hash = '';
  });
  afterEach(cleanup);

  it('messages an agent, broadcasts, sets the ticker and shows stats alerts', async () => {
    api.mockImplementation((path: string) =>
      path === '/desk/stats'
        ? Promise.resolve({ alerts: ['3 calls waiting (limit 2)'] })
        : Promise.resolve([]),
    );
    post.mockResolvedValue({});
    put.mockResolvedValue({});
    const agent = {
      userId: 'u1',
      name: 'Ann',
      state: 'ready' as const,
      reason: null,
      since: '2026-01-01T00:00:00Z',
      callId: null,
      acwUntil: null,
    };
    renderPage(fakeDesk({ agents: [agent], ticker: 'old news' }));
    expect(await screen.findByText('3 calls waiting (limit 2)')).toBeDefined();

    // direct message from the agent row menu, sent with Enter
    await userEvent.click(screen.getByRole('button', { name: 'actions for Ann' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Message…' }));
    await userEvent.type(screen.getByLabelText('Message Ann'), 'hi there{Enter}');
    expect(post).toHaveBeenCalledWith('/desk/messages', { text: 'hi there', toUserId: 'u1' });

    // broadcast to every desk
    await userEvent.type(screen.getByLabelText('Broadcast to every desk'), 'all hands');
    await userEvent.click(screen.getByRole('button', { name: 'Broadcast' }));
    expect(post).toHaveBeenLastCalledWith('/desk/messages', { text: 'all hands' });

    // the ticker field prefills from the live state and saves trimmed
    const ticker = screen.getByLabelText('Ticker banner (empty clears it)') as HTMLInputElement;
    expect(ticker.value).toBe('old news');
    await userEvent.clear(ticker);
    await userEvent.type(ticker, ' maintenance ');
    await userEvent.click(screen.getByRole('button', { name: 'Set ticker' }));
    expect(put).toHaveBeenCalledWith('/desk/ticker', { text: 'maintenance' });
  });

  it('shows empty states', async () => {
    api.mockResolvedValue([]);
    renderPage(fakeDesk({}));
    expect(await screen.findByText('No calls in progress.')).toBeTruthy();
    expect(screen.getByText('Nobody is online.')).toBeTruthy();
    expect(screen.getByText('Live calls (0)')).toBeTruthy();
  });

  it('lists live calls and agents, navigates to a call', async () => {
    api.mockResolvedValue(calls);
    renderPage(
      fakeDesk({
        callStatus: { c1: 'waiting_human' },
        agents: [
          {
            userId: 'u1',
            name: 'Ann',
            state: 'busy',
            reason: null,
            since: new Date(Date.now() - 65_000).toISOString(),
            callId: 'c2',
            acwUntil: null,
          },
          {
            userId: 'u2',
            name: 'Bob',
            state: 'not_ready',
            reason: 'Lunch',
            since: new Date().toISOString(),
            callId: null,
            acwUntil: null,
          },
        ],
      }),
    );
    expect(await screen.findByText('Live calls (2)')).toBeTruthy();
    expect(screen.getByText('https://shop/x')).toBeTruthy();
    // Socket status wins over the fetched row.
    expect(screen.getByText('Waiting for agent')).toBeTruthy();
    expect(screen.getByText('With agent')).toBeTruthy();
    expect(screen.getByText('Agents online (2)')).toBeTruthy();
    expect(screen.getByText('On a call')).toBeTruthy();
    expect(screen.getByText(/1:0\d/)).toBeTruthy();
    expect(screen.getByText('Not ready')).toBeTruthy();
    expect(screen.getByText(/Lunch · 0:0\d/)).toBeTruthy();
    await userEvent.click(screen.getByText(/support · /));
    expect(location.hash).toBe('#/calls/c1');

    // force-state menu: busy agents cannot be forced ready, everyone can be logged out
    post.mockResolvedValue({});
    await userEvent.click(screen.getByRole('button', { name: 'actions for Bob' }));
    await userEvent.click(screen.getByText('Force not ready'));
    expect(post).toHaveBeenCalledWith('/desk/agents/u2/state', {
      state: 'not_ready',
      reason: 'Supervisor',
    });
    await userEvent.click(screen.getByRole('button', { name: 'actions for Ann' }));
    expect(screen.getByText('Force ready').closest('li')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    await userEvent.click(screen.getByText('Log out'));
    expect(post).toHaveBeenLastCalledWith('/desk/agents/u1/state', { state: 'logged_out' });
  });
});
