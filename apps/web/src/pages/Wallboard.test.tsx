// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantStats } from '../lib/api.ts';
import { Wallboard } from './Wallboard.tsx';

const api = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.ts', () => ({ api }));

const stats: TenantStats = {
  waiting: 2,
  longestWaitSec: 31,
  active: 4,
  longestCallSec: 120,
  agents: { ready: 3, notReady: 1, busy: 2, acw: 1 },
  today: { calls: 10, answered: 7, avgHandleSec: 95 },
  alerts: ['2 calls waiting (limit 2)'],
};

const ui = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Wallboard />
    </QueryClientProvider>,
  );

describe('Wallboard', () => {
  afterEach(cleanup);

  it('renders the big numbers and the alert banners', async () => {
    api.mockResolvedValue(stats);
    ui();
    expect(await screen.findByText('2 calls waiting (limit 2)')).toBeDefined();
    expect(screen.getByText('Waiting').previousSibling?.textContent).toBe('2');
    expect(screen.getByText('Calls today').previousSibling?.textContent).toBe('10');
    expect(screen.getByText('Avg handle time (s)').previousSibling?.textContent).toBe('95');
  });

  it('shows a loading state before the first snapshot', () => {
    api.mockReturnValue(new Promise(() => undefined));
    ui();
    expect(screen.getByText('Loading…')).toBeDefined();
  });
});
