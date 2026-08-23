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
    requiredSkills: ['vip', 'lang:de'],
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
    api.mockImplementation((path: string) =>
      Promise.resolve(
        path === '/desk/settings'
          ? { skills: [{ key: 'vip', label: 'VIP customers', description: '' }] }
          : calls,
      ),
    );
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
    // the Skills column labels the call's pinned skills via the catalogue
    expect(screen.getByRole('columnheader', { name: 'Skills' })).toBeTruthy();
    expect(await screen.findByText('VIP customers')).toBeTruthy();
    expect(screen.getByText('Language: Deutsch')).toBeTruthy();
    await userEvent.click(screen.getByText('sales'));
    expect(location.hash).toBe('#/calls/c2');
    location.hash = '';
    // rows are keyboard-operable: Enter and Space open the call, other keys do nothing
    const row = screen.getByRole('row', { name: 'Open call c1 (support)' });
    row.focus();
    await userEvent.keyboard('{Tab}');
    await userEvent.keyboard('x');
    expect(location.hash).toBe('');
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(location.hash).toBe('#/calls/c1');
    location.hash = '';
    row.focus();
    await userEvent.keyboard(' ');
    expect(location.hash).toBe('#/calls/c1');
    location.hash = '';
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Calls');
  });
});
