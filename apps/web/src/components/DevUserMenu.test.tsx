// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevUserMenu } from './DevUserMenu.tsx';

const mocks = vi.hoisted(() => ({ api: vi.fn(), post: vi.fn() }));
vi.mock('../lib/api.ts', () => ({ api: mocks.api, post: mocks.post }));

const renderMenu = (onSwitched = vi.fn()) => {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DevUserMenu name="e2e" onSwitched={onSwitched} />
    </QueryClientProvider>,
  );
  return onSwitched;
};

describe('DevUserMenu', () => {
  beforeEach(() => {
    mocks.api.mockReset().mockResolvedValue({
      current: 'e2e@example.com',
      users: [
        { id: '1', email: 'alice@patchbay.dev', name: 'Alice' },
        { id: '2', email: 'e2e@example.com', name: 'e2e' },
      ],
    });
    mocks.post.mockReset().mockResolvedValue({});
  });
  afterEach(cleanup);

  it('lists the dev users and switches to the chosen one', async () => {
    const onSwitched = renderMenu();
    await userEvent.click(screen.getByText('Signed in as e2e'));
    await userEvent.click(await screen.findByText('Alice'));
    expect(mocks.post).toHaveBeenCalledWith('/auth/dev-switch', { email: 'alice@patchbay.dev' });
    expect(onSwitched).toHaveBeenCalled();
  });

  it('asks for another email, and does nothing when the prompt is cancelled', async () => {
    const onSwitched = renderMenu();
    vi.stubGlobal(
      'prompt',
      vi.fn(() => null),
    );
    await userEvent.click(screen.getByText('Signed in as e2e'));
    await userEvent.click(await screen.findByText('Other email…'));
    expect(mocks.post).not.toHaveBeenCalled();
    expect(onSwitched).not.toHaveBeenCalled();

    vi.stubGlobal(
      'prompt',
      vi.fn(() => 'dave@patchbay.dev'),
    );
    await userEvent.click(screen.getByText('Signed in as e2e'));
    await userEvent.click(await screen.findByText('Other email…'));
    expect(mocks.post).toHaveBeenCalledWith('/auth/dev-switch', { email: 'dave@patchbay.dev' });
    vi.unstubAllGlobals();
  });
});
