// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbedCard } from './EmbedCard.tsx';
import { data, mocks, renderCard, resetMocks, toastText } from './testing.tsx';

vi.mock('../../lib/api.ts', async () => (await import('./testing.tsx')).mocks);

describe('EmbedCard', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('shows embed keys with snippets, creates and deletes keys', async () => {
    renderCard(<EmbedCard />);
    expect(await screen.findByText('https://shop')).toBeTruthy();
    expect(screen.getByText('any origin')).toBeTruthy();
    const snippets = screen.getAllByLabelText(/Embed snippet/) as HTMLTextAreaElement[];
    expect(snippets[0]?.value).toContain(`<script src="${location.origin}/embed/call-button.js">`);
    expect(snippets[0]?.value).toContain('key="pk_1" queue="support"');
    await userEvent.click(screen.getByRole('button', { name: 'delete Blog' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete', exact: true }));
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('/admin/embed-keys/k2'));
    await waitFor(() => expect(toastText()).toContain('Key deleted'));

    const create = screen.getByRole('button', { name: 'Create key' });
    expect(create).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText(/^Label/), 'Docs');
    await userEvent.type(
      screen.getByLabelText(/Allowed origins/),
      'https://a.example, https://b.example',
    );
    await userEvent.click(create);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/admin/embed-keys', {
        label: 'Docs',
        allowedOrigins: ['https://a.example', 'https://b.example'],
      }),
    );
    await waitFor(() => expect(screen.getByLabelText(/^Label/)).toHaveProperty('value', ''));
  });

  it('falls back to the support queue in the snippet when no queue exists', async () => {
    mocks.api.mockImplementation((path: string) =>
      Promise.resolve(path === '/admin/queues' ? [] : data[path]),
    );
    renderCard(<EmbedCard />);
    const snippet = (await screen.findAllByLabelText(/Embed snippet/))[0] as HTMLTextAreaElement;
    expect(snippet.value).toContain('queue="support"');
  });
});
