// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransferConsult } from './TransferConsult.tsx';

const mocks = vi.hoisted(() => ({ api: vi.fn(), post: vi.fn() }));
vi.mock('../lib/api.ts', () => ({ api: mocks.api, post: mocks.post }));

const presence = (userId: string, name: string, state = 'ready') => ({
  userId,
  name,
  state,
  reason: null,
  since: '2026-01-01T00:00:00Z',
  callId: null,
  acwUntil: null,
});

const renderIt = (
  consultants: { userId: string | null; name: string }[] = [],
  onLeft = vi.fn(),
) => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TransferConsult
        callId="c1"
        myUserId="me"
        consultants={consultants}
        onLeft={onLeft}
        onError={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return onLeft;
};

describe('TransferConsult', () => {
  beforeEach(() => {
    mocks.api
      .mockReset()
      .mockImplementation(async (path: string) =>
        path === '/desk/agents'
          ? [presence('me', 'Me'), presence('u2', 'Bob'), presence('u3', 'Carol', 'busy')]
          : { queues: [{ id: 'q1', key: 'support', name: 'Support' }] },
      );
    mocks.post.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(cleanup);

  it('transfers to a queue or a ready colleague and closes the panel', async () => {
    const onLeft = renderIt();
    await userEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    expect(await screen.findByText('Queue: Support')).toBeTruthy();
    expect(screen.queryByText('Carol')).toBeNull(); // busy colleagues are not offered
    expect(screen.queryByText('Me')).toBeNull();
    await userEvent.click(screen.getByText('Bob'));
    expect(mocks.post).toHaveBeenCalledWith('/desk/calls/c1/transfer', {
      target: { kind: 'user', id: 'u2' },
    });
    await vi.waitFor(() => expect(onLeft).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    await userEvent.click(await screen.findByText('Queue: Support'));
    expect(mocks.post).toHaveBeenLastCalledWith('/desk/calls/c1/transfer', {
      target: { kind: 'queue', id: 'q1' },
    });
  });

  it('starts a consultation and shows the completion buttons while one is active', async () => {
    renderIt();
    await userEvent.click(screen.getByRole('button', { name: 'Consult' }));
    await userEvent.click(await screen.findByText('Bob'));
    expect(mocks.post).toHaveBeenCalledWith('/desk/calls/c1/consult', { targetUserId: 'u2' });

    cleanup();
    const onLeft = renderIt([{ userId: 'u2', name: 'Bob' }]);
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Conference' }));
    expect(mocks.post).toHaveBeenLastCalledWith('/desk/calls/c1/consult/complete', {
      mode: 'conference',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Drop Bob' }));
    expect(mocks.post).toHaveBeenLastCalledWith('/desk/calls/c1/consult/complete', {
      mode: 'drop',
    });
    await userEvent.click(screen.getByRole('button', { name: 'Hand over to Bob' }));
    expect(mocks.post).toHaveBeenLastCalledWith('/desk/calls/c1/consult/complete', {
      mode: 'transfer',
    });
    await vi.waitFor(() => expect(onLeft).toHaveBeenCalled());
  });
});
