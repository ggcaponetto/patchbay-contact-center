// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallSummary } from '../lib/api.ts';
import { initialState } from '../lib/store.ts';
import { History } from './History.tsx';

const api = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.ts', () => ({ api }));

const calls: CallSummary[] = [
  {
    id: 'c1',
    status: 'ended',
    queueKey: 'support',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:01:05Z',
    aiSummary: 'Asked about refunds',
    customerMeta: {},
  },
  {
    id: 'c2',
    status: 'ai',
    queueKey: 'sales',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    aiSummary: null,
    customerMeta: {},
  },
];

describe('History', () => {
  afterEach(cleanup);

  it('lists calls and opens one', async () => {
    api.mockResolvedValue(calls);
    const desk = { state: initialState, dispatch: vi.fn(), send: vi.fn(), setStatus: vi.fn() };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <History desk={desk} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Asked about refunds')).toBeTruthy();
    expect(api).toHaveBeenCalledWith('/desk/calls');
    expect(screen.getByText('1:05')).toBeTruthy();
    expect(screen.getByText('Ended')).toBeTruthy();
    expect(screen.getByText('With AI')).toBeTruthy();
    await userEvent.click(screen.getByText('sales'));
    expect(location.hash).toBe('#/calls/c2');
    location.hash = '';
  });
});
