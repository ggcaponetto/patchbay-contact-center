// @vitest-environment jsdom
import { defaultTenantSettings } from '@cc/shared';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutingCard, routingSettings } from './RoutingCard.tsx';
import { mocks, renderCard, resetMocks, select, toastText } from './testing.tsx';

vi.mock('../../lib/api.ts', async () => (await import('./testing.tsx')).mocks);

describe('RoutingCard', () => {
  beforeEach(resetMocks);
  afterEach(cleanup);

  it('sends only its own keys', () => {
    const own = routingSettings(defaultTenantSettings());
    expect(own).not.toHaveProperty('hours');
    expect(own).not.toHaveProperty('sounds');
    expect(own).not.toHaveProperty('ticker');
    expect(own.routingMode).toBe('ai-first');
  });

  it('edits routing, wrap-up codes and reasons, saves with a toast and shows errors', async () => {
    renderCard(<RoutingCard />);
    await screen.findByText('Routing & AI');
    await select(/Who answers first/, /Ring humans first/);
    await select(/When a human takes over/, /stays muted/);
    await userEvent.clear(screen.getByLabelText(/Ring each agent for/));
    await userEvent.type(screen.getByLabelText(/Ring each agent for/), '45');
    await userEvent.clear(screen.getByLabelText(/Wrap-up time/));
    await userEvent.type(screen.getByLabelText(/Wrap-up time/), '15');
    // not-ready reasons are chips: Enter adds, ✕ removes
    await userEvent.type(screen.getByLabelText(/Not-ready reason codes/), 'Yoga{Enter}');
    await userEvent.type(screen.getByLabelText(/Not-ready reason codes/), 'Coffee');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Coffee')).toBeTruthy();
    await userEvent.click(screen.getByText('Coffee').parentElement!.querySelector('svg')!);
    // routing skill catalogue: the seeded entry can be removed
    await userEvent.click(screen.getByRole('button', { name: 'remove skill German tax' }));
    // wrap-up codes: examples, then a custom one with the code derived from the label
    await userEvent.click(screen.getByRole('button', { name: 'Add examples' }));
    expect(screen.getAllByLabelText('Code')).toHaveLength(5);
    await userEvent.click(screen.getByRole('button', { name: 'remove code Callback scheduled' }));
    await userEvent.click(screen.getByRole('button', { name: '+ Add code' }));
    const labels = screen.getAllByLabelText('Label');
    await userEvent.type(labels[labels.length - 1]!, 'Billing / Refund');
    const codes = screen.getAllByLabelText('Code') as HTMLInputElement[];
    expect(codes[codes.length - 1]!.value).toBe('billing/refund');
    // routing skill catalogue: add one with a derived key (the seeded one went above)
    await userEvent.click(screen.getByRole('button', { name: '+ Add skill' }));
    await userEvent.type(screen.getAllByLabelText('Label').at(-1)!, 'VIP customers');
    expect((screen.getByLabelText('Key') as HTMLInputElement).value).toBe('vip-customers');
    await userEvent.type(
      screen.getByLabelText(/Description \(what the AI should match\)/),
      'Gold and platinum members',
    );
    await userEvent.click(screen.getByLabelText(/Disposition required/));
    await userEvent.clear(screen.getByLabelText(/AI greeting instruction/));
    await userEvent.type(screen.getByLabelText(/AI greeting instruction/), 'Say hi');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith('/admin/tenant/settings', {
        ...routingSettings(defaultTenantSettings()),
        routingMode: 'human-first',
        handoff: { aiBehavior: 'listen' },
        offerTimeoutSec: 45,
        acwSec: 15,
        notReadyReasons: [...defaultTenantSettings().notReadyReasons, 'Yoga'],
        dispositions: [
          { code: 'resolved', label: 'Resolved' },
          { code: 'ticket', label: 'Created ticket' },
          { code: 'docs', label: 'Documentation update' },
          { code: 'escalated', label: 'Escalated' },
          { code: 'billing/refund', label: 'Billing / Refund' },
        ],
        dispositionRequired: true,
        aiAgent: { greeting: 'Say hi', instructions: '' },
        skills: [
          {
            key: 'vip-customers',
            label: 'VIP customers',
            description: 'Gold and platinum members',
          },
        ],
      }),
    );
    expect(toastText()).toContain('saved');

    mocks.patch.mockRejectedValueOnce(new Error('invalid_settings'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toastText()).toContain('invalid_settings'));
  }, 40_000);
});
