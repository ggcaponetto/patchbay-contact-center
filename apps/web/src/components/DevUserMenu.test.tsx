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
    sessionStorage.clear();
    mocks.api.mockReset().mockImplementation(async (_path: string, init?: RequestInit) => ({
      // asked with an empty header = the API's default user
      current:
        (init?.headers as Record<string, string> | undefined)?.['x-dev-user'] === ''
          ? 'e2e@example.com'
          : sessionStorage.getItem('cc_dev_user') || 'e2e@example.com',
      users: [
        { id: '1', email: 'alice@patchbay.dev', name: 'Alice' },
        { id: '2', email: 'e2e@example.com', name: 'e2e' },
      ],
    }));
    mocks.post.mockReset().mockResolvedValue({});
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('lists the dev users and switches this tab to the chosen one without a request', async () => {
    const onSwitched = renderMenu();
    await userEvent.click(screen.getByText('Signed in as e2e'));
    expect(screen.queryByText(/^Back to/)).toBeNull();
    await userEvent.click(await screen.findByText('Alice'));
    expect(sessionStorage.getItem('cc_dev_user')).toBe('alice@patchbay.dev');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(onSwitched).toHaveBeenCalled();
  });

  it('opens a person in a new tab, leaving this tab as it is', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const onSwitched = renderMenu();
    await userEvent.click(screen.getByText('Signed in as e2e'));
    await userEvent.click(await screen.findByRole('button', { name: 'Open in new tab as Alice' }));
    expect(open).toHaveBeenCalledWith('/#/?as=alice%40patchbay.dev', '_blank');
    expect(sessionStorage.getItem('cc_dev_user')).toBeNull();
    expect(onSwitched).not.toHaveBeenCalled();
  });

  it('offers "Back to <default>" when this tab is someone else', async () => {
    sessionStorage.setItem('cc_dev_user', 'alice@patchbay.dev');
    const onSwitched = renderMenu();
    await userEvent.click(screen.getByText('Signed in as e2e'));
    await userEvent.click(await screen.findByText('Back to e2e@example.com'));
    expect(sessionStorage.getItem('cc_dev_user')).toBeNull();
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
    expect(sessionStorage.getItem('cc_dev_user')).toBeNull();
    expect(onSwitched).not.toHaveBeenCalled();

    vi.stubGlobal(
      'prompt',
      vi.fn(() => 'dave@patchbay.dev'),
    );
    await userEvent.click(screen.getByText('Signed in as e2e'));
    await userEvent.click(await screen.findByText('Other email…'));
    expect(sessionStorage.getItem('cc_dev_user')).toBe('dave@patchbay.dev');
    expect(onSwitched).toHaveBeenCalled();
  });
});
