// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeysCard } from './ApiKeysCard.tsx';

const mocks = vi.hoisted(() => ({ api: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock('../lib/api.ts', () => ({ api: mocks.api, post: mocks.post, del: mocks.del }));

const key = {
  id: 'k1',
  name: 'crm',
  prefix: 'ak_0123456789',
  permissions: ['calls:read'],
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: null,
  revokedAt: null,
};

describe('ApiKeysCard', () => {
  beforeEach(() => {
    mocks.api
      .mockReset()
      .mockResolvedValue([key, { ...key, id: 'k2', name: 'old', revokedAt: 'x' }]);
    mocks.post.mockReset();
    mocks.del.mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(cleanup);

  it('lists keys, creates one showing the secret once, and revokes', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ApiKeysCard />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('crm')).toBeTruthy();
    expect(screen.getByText('revoked')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'revoke old' })).toBeNull();

    mocks.post.mockResolvedValueOnce({ ...key, id: 'k3', name: 'zap', secret: 'ak_secret' });
    await userEvent.type(screen.getByLabelText('Key name'), 'zap');
    await userEvent.click(screen.getByLabelText('tenant:read'));
    await userEvent.click(screen.getByLabelText('calls:read')); // off again
    expect(
      (screen.getByRole('button', { name: 'Create API key' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Create API key' }));
    expect(mocks.post).toHaveBeenCalledWith('/admin/api-keys', {
      name: 'zap',
      permissions: ['tenant:read'],
    });
    expect(((await screen.findByLabelText('New API key')) as HTMLInputElement).value).toBe(
      'ak_secret',
    );

    await userEvent.click(screen.getByRole('button', { name: 'revoke crm' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/admin/api-keys/k1/revoke', {}));
  });

  it('deletes keys (revoked ones too) after a confirmation', async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ApiKeysCard />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('crm')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'delete old' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/admin/api-keys/k2'));
  });
});
