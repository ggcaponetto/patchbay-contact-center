// @vitest-environment jsdom
import type { AgentPresence } from '@cc/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StateBar } from './StateBar.tsx';

const mocks = vi.hoisted(() => ({ api: vi.fn(), post: vi.fn() }));
vi.mock('../lib/api.ts', () => ({ api: mocks.api, post: mocks.post }));

const NOW = Date.parse('2026-01-01T00:01:00Z');
const presence = (p: Partial<AgentPresence>): AgentPresence => ({
  userId: 'u1',
  name: 'Ann',
  state: 'not_ready',
  reason: null,
  since: '2026-01-01T00:00:00Z',
  callId: null,
  acwUntil: null,
  ...p,
});

const renderBar = (me: AgentPresence | undefined, onError = vi.fn()) => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <StateBar name="Ann" me={me} now={NOW} onError={onError} />
    </QueryClientProvider>,
  );
  return onError;
};

describe('StateBar', () => {
  beforeEach(() => {
    mocks.api.mockReset().mockResolvedValue({
      notReadyReasons: ['Break', 'Lunch'],
      acwSec: 30,
      dispositions: [{ code: 'billing/refund', label: 'Refund' }],
      dispositionRequired: true,
    });
    mocks.post.mockReset().mockResolvedValue({});
  });
  afterEach(cleanup);

  it('shows the state with its timer and asks the server for Ready / Not ready + reason', async () => {
    renderBar(presence({ state: 'not_ready', reason: 'Lunch' }));
    expect(screen.getByText('Not ready · Lunch · 1:00')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ready' }));
    expect(mocks.post).toHaveBeenCalledWith('/desk/state', { state: 'ready', reason: undefined });
    await userEvent.click(screen.getByRole('button', { name: 'Not ready' }));
    await userEvent.click(await screen.findByText('Break'));
    expect(mocks.post).toHaveBeenLastCalledWith('/desk/state', {
      state: 'not_ready',
      reason: 'Break',
    });
  });

  it('disables the controls while offline or on a call, and reports failures', async () => {
    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <StateBar name="Ann" me={undefined} now={NOW} onError={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Connecting…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Ready' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    const onError = vi.fn();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <StateBar
          name="Ann"
          me={presence({ state: 'busy', callId: 'c1' })}
          now={NOW}
          onError={onError}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText('On a call · 1:00')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Ready' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    mocks.post.mockRejectedValueOnce(new Error('on_call'));
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <StateBar name="Ann" me={presence({ state: 'ready' })} now={NOW} onError={onError} />
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ready' }));
    expect(onError).toHaveBeenCalledWith('on_call');
  });

  it('shows the wrap-up countdown with disposition, Extend and Done', async () => {
    renderBar(presence({ state: 'acw', callId: 'c1', acwUntil: '2026-01-01T00:01:25Z' }));
    expect(screen.getByText('Wrap-up: 25s left')).toBeTruthy();
    await userEvent.click(await screen.findByLabelText('Disposition'));
    await userEvent.click(await screen.findByText('billing · Refund'));
    expect(mocks.post).toHaveBeenCalledWith('/desk/calls/c1/disposition', {
      code: 'billing/refund',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Extend' }));
    expect(mocks.post).toHaveBeenCalledWith('/desk/acw/extend');
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(mocks.post).toHaveBeenLastCalledWith('/desk/acw/done');
  });
});
