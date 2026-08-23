// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_TABS, Settings } from './Settings.tsx';

// Each card is tested on its own (components/settings/*.test.tsx); here only the tabs.
vi.mock('../components/settings/RoutingCard.tsx', () => ({ RoutingCard: () => <p>routing!</p> }));
vi.mock('../components/settings/HoursCard.tsx', () => ({ HoursCard: () => <p>hours!</p> }));
vi.mock('../components/settings/TeamCard.tsx', () => ({ TeamCard: () => <p>team!</p> }));
vi.mock('../components/settings/QueuesCard.tsx', () => ({ QueuesCard: () => <p>queues!</p> }));
vi.mock('../components/settings/SoundsCard.tsx', () => ({ SoundsCard: () => <p>sounds!</p> }));
vi.mock('../components/settings/EmbedCard.tsx', () => ({ EmbedCard: () => <p>embed!</p> }));
vi.mock('../components/ApiKeysCard.tsx', () => ({ ApiKeysCard: () => <p>keys!</p> }));

describe('Settings', () => {
  afterEach(() => {
    cleanup();
    location.hash = '';
  });

  it('shows the tab of the route, the first one by default, and navigates by hash', async () => {
    const { rerender } = render(<Settings />);
    expect(screen.getByText('routing!')).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(SETTINGS_TABS.length);
    rerender(<Settings tab="queues" />);
    expect(screen.getByText('queues!')).toBeTruthy();
    rerender(<Settings tab="nope" />);
    expect(screen.getByText('routing!')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'API keys' }));
    expect(location.hash).toBe('#/settings/api-keys');
  });
});
