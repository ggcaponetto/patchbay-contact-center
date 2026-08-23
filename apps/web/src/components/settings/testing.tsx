/**
 * Test helpers shared by the settings card tests: the mocked `lib/api.ts` functions,
 * canned `GET /api/admin/*` responses, a render wrapper with a query client and toast
 * provider, and a MUI select helper. Not part of the app bundle (tests only).
 */
import { defaultTenantSettings } from '@cc/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { ToastProvider } from '../../lib/useToast.tsx';

/**
 * The mocked API surface; register with
 * `vi.mock('../../lib/api.ts', async () => (await import('./testing.tsx')).mocks)`.
 */
export const mocks = {
  api: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  uploadMediaAsset: vi.fn(),
};

/** Canned responses per `GET /api/admin/*` path. */
export const data: Record<string, unknown> = {
  '/admin/tenant': {
    id: 't',
    name: 'Acme',
    slug: 'acme',
    settings: {
      ...defaultTenantSettings(),
      skills: [{ key: 'german-tax', label: 'German tax', description: 'Tax questions' }],
    },
  },
  '/admin/members': [
    { userId: 'u1', name: 'Ann', email: 'ann@x', role: 'supervisor' },
    { userId: 'u2', name: 'Bob', email: 'bob@x', role: 'agent' },
  ],
  '/admin/invites': [
    { id: 'i1', email: 'new@x', role: 'agent', acceptedAt: null },
    { id: 'i2', email: 'old@x', role: 'agent', acceptedAt: '2026-01-01T00:00:00Z' },
  ],
  '/admin/queues': [
    {
      id: 'q1',
      key: 'support',
      name: 'Support',
      memberIds: ['u1'],
      config: { requiredSkills: [{ skill: 'vip', min: 2 }], moh: 'bright' },
    },
  ],
  '/admin/members/u1/skills': [{ skill: 'billing', proficiency: 2 }],
  '/admin/members/u2/skills': [],
  '/admin/embed-keys': [
    { id: 'k1', label: 'Shop', publicKey: 'pk_1', allowedOrigins: ['https://shop'] },
    { id: 'k2', label: 'Blog', publicKey: 'pk_2', allowedOrigins: [] },
  ],
  '/admin/media-assets': [
    {
      id: 'a1',
      name: 'jingle.wav',
      mimeType: 'audio/wav',
      sizeBytes: 2048,
      createdAt: '2026-01-01T00:00:00Z',
      url: '/api/public/media/a1',
    },
    {
      id: 'a2',
      name: 'ring.mp3',
      mimeType: 'audio/mpeg',
      sizeBytes: 3 * 1024 * 1024,
      createdAt: '2026-01-01T00:00:00Z',
      url: '/api/public/media/a2',
    },
  ],
};

/** Resets the mocks to the canned data (call in `beforeEach`). */
export function resetMocks() {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.api.mockImplementation((path: string) => Promise.resolve(data[path]));
  for (const m of [mocks.post, mocks.patch, mocks.put, mocks.del]) m.mockResolvedValue({});
}

/** Renders inside a fresh query client and a toast provider. */
export function renderCard(ui: ReactElement) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

/** Picks an option of a MUI select opened from the element labelled `label`. */
export async function select(label: string | RegExp, option: string | RegExp) {
  await userEvent.click(screen.getByLabelText(label));
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

/** The text of the toast currently shown. */
export const toastText = () => screen.getByRole('status').textContent;
