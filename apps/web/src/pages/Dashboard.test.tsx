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
vi.mock('../lib/api.ts', () => ({ api }));

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
          { userId: 'u1', name: 'Ann', status: 'busy', callId: 'c2' },
          { userId: 'u2', name: 'Bob', status: 'available', callId: null },
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
    expect(screen.getByText('available')).toBeTruthy();
    await userEvent.click(screen.getByText(/support · /));
    expect(location.hash).toBe('#/calls/c1');
  });
});
